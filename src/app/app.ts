import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  ViewChild,
  signal,
  computed,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatCardModule } from '@angular/material/card';
import { MatToolbarModule } from '@angular/material/toolbar';
import { MatListModule } from '@angular/material/list';
import { MatChipsModule } from '@angular/material/chips';
import { GoogleGenAI, Type } from '@google/genai';
import { signInWithPopup, signOut, onAuthStateChanged, User } from 'firebase/auth';
import { collection, query, orderBy, limit, onSnapshot, addDoc, serverTimestamp, doc, getDocFromServer, Timestamp } from 'firebase/firestore';
import { auth, db, googleAuthProvider, handleFirestoreError, OperationType } from './firebase';

interface SecurityEvent {
  id: string;
  timestamp: Date;
  type: 'shoplifting' | 'fall' | 'suspicious' | 'error' | 'normal';
  description: string;
  confidence: number;
  imageUrl: string;
}

interface StreamFeed {
  id: string;
  name: string;
  videoUrl?: string; 
  mediaStream?: MediaStream;
  frameBuffer: string[];
  frameCount: number;
  confidence: number;
  status: string;
  aiStage: string;
  hasMotion: boolean;
  isAnalyzing: boolean;
  lastImageData?: ImageData;
}

@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-root',
  imports: [
    CommonModule,
    MatButtonModule,
    MatIconModule,
    MatCardModule,
    MatToolbarModule,
    MatListModule,
    MatChipsModule,
  ],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App implements OnDestroy, OnInit {
  @ViewChild('fileInput') fileInput!: ElementRef<HTMLInputElement>;

  events = signal<SecurityEvent[]>([]);
  latestEvent = computed(() => this.events()[0]);
  
  feeds = signal<StreamFeed[]>([]);
  
  user = signal<User | null>(null);
  authLoaded = signal(false);
  
  currentTheme = signal<'stealth' | 'crimson' | 'cyberpunk' | 'classic'>('stealth');
  
  autoSaveEnabled = signal(true);
  showSettings = signal(false);
  dailyDigest = signal<string | null>(null);
  isGeneratingDigest = signal(false);
  
  videoBlobs = signal<Map<string, string>>(new Map());
  selectedEvent = signal<SecurityEvent | null>(null);

  isEventsLoading = signal(false);
  eventsError = signal<string | null>(null);

  currentUserRole = signal<'admin' | 'manager' | 'viewer'>('admin');
  
  canManageFeeds = computed(() => this.currentUserRole() === 'admin');
  canGenerateDigest = computed(() => this.currentUserRole() === 'admin' || this.currentUserRole() === 'manager');
  canSeeConfidence = computed(() => this.currentUserRole() === 'admin' || this.currentUserRole() === 'manager');
  
  private monitorInterval: ReturnType<typeof setInterval> | null = null;
  private ai: GoogleGenAI;
  private eventsUnsubscribe: (() => void) | null = null;
  private recorders = new Map<string, { recorder: MediaRecorder, chunks: Blob[] }>();

  constructor() {
    this.ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  }

  ngOnInit() {
    const savedTheme = localStorage.getItem('clepto_trap_theme');
    const themes = ['stealth', 'crimson', 'cyberpunk', 'classic'] as const;
    const isTheme = (t: string | null): t is typeof themes[number] => 
      !!t && (themes as readonly string[]).includes(t);
      
    if (isTheme(savedTheme)) {
      this.currentTheme.set(savedTheme);
    }

    onAuthStateChanged(auth, (user) => {
      this.user.set(user);
      this.authLoaded.set(true);
      if (user) {
        this.testConnection();
        this.subscribeToEvents(user.uid);
      } else {
        if (this.eventsUnsubscribe) {
          this.eventsUnsubscribe();
          this.eventsUnsubscribe = null;
        }
        this.events.set([]);
      }
    });
  }

  async testConnection() {
    try {
      await getDocFromServer(doc(db, 'test', 'connection'));
    } catch (error) {
      if(error instanceof Error && error.message.includes('the client is offline')) {
        console.error("Please check your Firebase configuration.");
      }
    }
  }

  async login() {
    try {
      await signInWithPopup(auth, googleAuthProvider);
    } catch (e) {
      console.error('Login error', e);
    }
  }

  async logout() {
    await signOut(auth);
  }

  subscribeToEvents(userId: string) {
    this.isEventsLoading.set(true);
    this.eventsError.set(null);
    const path = `users/${userId}/events`;
    const eventsRef = collection(db, 'users', userId, 'events');
    const q = query(eventsRef, orderBy('timestamp', 'desc'), limit(50));
    this.eventsUnsubscribe = onSnapshot(q, (snapshot) => {
      const data: SecurityEvent[] = [];
      snapshot.forEach(docSnap => {
        const docData = docSnap.data();
        let date = new Date();
        if (docData['timestamp'] instanceof Timestamp) {
          date = docData['timestamp'].toDate();
        } else if (docData['timestamp']) {
           date = new Date(docData['timestamp']);
        }
        data.push({
          id: docSnap.id,
          timestamp: date,
          type: docData['type'],
          description: docData['description'],
          confidence: docData['confidence'],
          imageUrl: docData['imageUrl']
        } as SecurityEvent);
      });
      this.events.set(data);
      this.isEventsLoading.set(false);
    }, (error) => {
       this.isEventsLoading.set(false);
       this.eventsError.set(error.message);
       handleFirestoreError(error, OperationType.GET, path);
    });
  }

  ngOnDestroy() {
    this.feeds().forEach(f => this.removeFeed(f.id));
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
    }
    if (this.eventsUnsubscribe) {
      this.eventsUnsubscribe();
    }
  }

  triggerFileInput() {
    this.fileInput.nativeElement.click();
  }

  async handleFileUpload(event: Event) {
    const fileList = (event.target as HTMLInputElement).files;
    if (!fileList) return;
    
    const files = Array.from(fileList);
    for (const file of files) {
       const id = Math.random().toString(36).substring(2, 9);
       const feed: StreamFeed = {
         id,
         name: file.name,
         videoUrl: URL.createObjectURL(file),
         frameBuffer: [],
         frameCount: 0,
         confidence: 0,
         status: 'normal',
         aiStage: 'Buffering (0/5)',
         hasMotion: true,
         isAnalyzing: false
       };
       this.feeds.update(f => [...f, feed]);
       
       setTimeout(() => {
          const video = document.getElementById('video-' + id) as HTMLVideoElement;
          if (video && feed.videoUrl) {
             video.src = feed.videoUrl;
             video.play().then(() => {
                // Use type assertion to access non-standard captureStream
                const videoEl = video as HTMLVideoElement & { captureStream?: () => MediaStream, mozCaptureStream?: () => MediaStream };
                const stream = videoEl.captureStream?.() || videoEl.mozCaptureStream?.();
                if (stream) this.setupRecorder(id, stream);
             }).catch(() => {
                // Auto-play blocked - user interaction required
             });
          }
       }, 200);
    }
    
    if (!this.monitorInterval) {
       this.monitorInterval = setInterval(() => this.processAllFeeds(), 1000);
    }
    
    // reset input
    (event.target as HTMLInputElement).value = '';
  }

  async addCameraFeed() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
        audio: false,
      });
      
      const id = Math.random().toString(36).substring(2, 9);
      const feed: StreamFeed = {
        id,
        name: 'CAM-' + id.substring(0,4).toUpperCase(),
        mediaStream: stream,
        frameBuffer: [],
        frameCount: 0,
        confidence: 0,
        status: 'normal',
        aiStage: 'Buffering (0/5)',
        hasMotion: true,
        isAnalyzing: false
      };
      
      this.feeds.update(f => [...f, feed]);
      
      setTimeout(() => {
         const video = document.getElementById('video-' + id) as HTMLVideoElement;
         if (video && feed.mediaStream) {
            video.srcObject = feed.mediaStream;
            video.play().then(() => {
                this.setupRecorder(id, feed.mediaStream!);
            }).catch(e => console.error("Auto-play blocked:", e));
         }
      }, 200);
      
      if (!this.monitorInterval) {
         this.monitorInterval = setInterval(() => this.processAllFeeds(), 1000);
      }
    } catch (err) {
      console.error('Error accessing camera:', err);
      alert('Could not access camera. Please ensure permissions are granted.');
    }
  }

  removeFeed(id: string) {
    const state = this.recorders.get(id);
    if (state) {
       try { state.recorder.stop(); } catch { /* ignore stop error */ }
       this.recorders.delete(id);
    }
    const feed = this.feeds().find(f => f.id === id);
    if (feed) {
       if (feed.mediaStream) {
          feed.mediaStream.getTracks().forEach(t => t.stop());
       }
       if (feed.videoUrl) {
          URL.revokeObjectURL(feed.videoUrl);
       }
    }
    this.feeds.update(fs => fs.filter(f => f.id !== id));
    if (this.feeds().length === 0 && this.monitorInterval) {
       clearInterval(this.monitorInterval);
       this.monitorInterval = null;
    }
  }

  private updateFeed(id: string, changes: Partial<StreamFeed>) {
    this.feeds.update(fs => fs.map(f => f.id === id ? { ...f, ...changes } : f));
  }

  private processAllFeeds() {
    const feedsList = this.feeds();
    for (const feed of feedsList) {
      if (feed.isAnalyzing) continue;
      
      const video = document.getElementById('video-' + feed.id) as HTMLVideoElement;
      const canvas = document.getElementById('canvas-' + feed.id) as HTMLCanvasElement;
      if (!video || !canvas || video.videoWidth === 0) continue;
      
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) continue;
      
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const currentImgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      
      let hasMotion = false;
      if (feed.lastImageData) {
        hasMotion = this.detectMotion(feed.lastImageData, currentImgData);
      } else {
        hasMotion = true; 
      }
      
      this.updateFeed(feed.id, { lastImageData: currentImgData, hasMotion });
      
      if (hasMotion) {
         const dataUrl = canvas.toDataURL('image/jpeg', 0.6);
         const base64Data = dataUrl.split(',')[1];
         
         const newBuffer = [...feed.frameBuffer, base64Data];
         if (newBuffer.length > 5) {
            newBuffer.shift();
         }
         
         const newFrameCount = feed.frameCount + 1;
         
         if (newBuffer.length === 5 && newFrameCount % 5 === 0) {
            this.updateFeed(feed.id, { frameBuffer: newBuffer, frameCount: newFrameCount, aiStage: 'Analyzing sequence...', isAnalyzing: true });
            this.analyzeTemporalSequence(feed.id, newBuffer, dataUrl);
         } else {
            this.updateFeed(feed.id, { frameBuffer: newBuffer, frameCount: newFrameCount, aiStage: `Buffering frames (${newBuffer.length}/5)` });
         }
      } else {
         this.updateFeed(feed.id, { aiStage: `Paused (No Motion)` });
      }
    }
  }

  private detectMotion(prev: ImageData, curr: ImageData): boolean {
    const threshold = 50; 
    let diffPixels = 0;
    const totalPixels = curr.width * curr.height;
    const step = 4 * 10;
    for (let i = 0; i < curr.data.length; i += step) {
       const rDiff = Math.abs(curr.data[i] - prev.data[i]);
       const gDiff = Math.abs(curr.data[i+1] - prev.data[i+1]);
       const bDiff = Math.abs(curr.data[i+2] - prev.data[i+2]);
       if (rDiff + gDiff + bDiff > threshold) diffPixels++;
    }
    const pct = diffPixels / (totalPixels / 10);
    return pct > 0.01;
  }

  private async analyzeTemporalSequence(feedId: string, frames: string[], lastFrameUrl: string) {
    try {
      const prompt = `You are Lexius, a high-fidelity behavioral analysis AI specialized in retail loss prevention.
You are analyzing a temporal sequence of 5 frames from a retail security camera representing the 10-second window leading up to the current moment.

DIFFERENTIATION PROTOCOL:
1. 'shoplifting' (THEFT): Requires confirmed CONCEALMENT or REMOVAL of intent. Look for:
   - "The Shield": Using the body to hide a hand grabbing an item.
   - "The Transfer": Rapidly moving an item from a shelf into a pocket, waistband, bag, or under clothing.
   - "The Double-Handle": Picking up two items, but only putting one back while retaining the other in a palm or sleeve.
2. 'suspicious' (LOITERING/STAGING): Unusual behavior WITHOUT confirmed concealment. Look for:
   - "Scan & Prowl": Looking at cameras or employees rather than merchandise.
   - "The Staging": Moving high-value items to a low-visibility area (blind spot) to be picked up later.
   - "Lingering": Remaining in a high-theft zone (e.g., electronics, cosmetics) for >30 seconds without interacting with products in a standard way.
3. 'fall' (SAFETY): Rapid vertical descent of a human skeleton ending in a prone or seated position on the floor.
4. 'normal' (STANDARD): Interaction with products followed by placing them in a cart, or simply walking through aisles.

ACTION DESCRIPTION REQUIREMENTS:
- Describe the movement trajectory: (e.g., "Right hand moved from shelf at chest height to inner left jacket pocket in under 2 seconds").
- Identify environmental context: (e.g., "Near the end-of-aisle display of premium headphones").
- Specify the gesture: (e.g., "Palming", "Sweeping into bag", "Shoulder-checking behavior").
- Privacy: Focus on body mechanics and hand-object interaction. DO NOT identify faces.

Return a JSON object with 'type', 'description' (a technical, chronological account of the observed sequence), and 'confidence' (0.0 to 1.0).`;

      // Construct parts array for Gemini 1.5/3.0 to process multiple images
      const contentsArray: { inlineData: { data: string, mimeType: string } }[] = frames.map((b64) => ({
        inlineData: {
          data: b64,
          mimeType: 'image/jpeg',
        }
      }));
      const contentsAndPrompt: (string | { inlineData: { data: string, mimeType: string } })[] = [...contentsArray, prompt];

      const response = await this.ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: contentsAndPrompt,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              type: {
                type: Type.STRING,
                description: "The type of event detected."
              },
              description: {
                type: Type.STRING,
                description: "A brief description of the detected event."
              },
              confidence: {
                type: Type.NUMBER,
                description: "Confidence level of the detection, between 0 and 1."
              }
            },
            required: ['type', 'description', 'confidence']
          }
        }
      });

      const resultText = response.text;
      if (resultText) {
        const result = JSON.parse(resultText);
        
        this.updateFeed(feedId, { status: result.type, confidence: result.confidence, aiStage: 'Awaiting detection', isAnalyzing: false });
        
        // Only log non-normal events or high confidence suspicious events
        if (result.type !== 'normal' && result.confidence > 0.65) {
          const feedName = this.feeds().find(f => f.id === feedId)?.name || feedId;
          const newEvent: SecurityEvent = {
            id: Math.random().toString(36).substring(2, 9),
            timestamp: new Date(),
            type: result.type,
            description: `[${feedName}] ${result.description}`,
            confidence: result.confidence,
            imageUrl: lastFrameUrl // Keep last frame for the thumbnail
          };
          
          let finalEventId = newEvent.id;
          if (this.user()) {
            const path = `users/${this.user()!.uid}/events`;
            try {
              // Save to Firestore
              const eventsRef = collection(db, 'users', this.user()!.uid, 'events');
              const docRef = await addDoc(eventsRef, {
                 type: newEvent.type,
                 description: newEvent.description,
                 confidence: newEvent.confidence,
                 imageUrl: newEvent.imageUrl,
                 timestamp: serverTimestamp()
              });
              finalEventId = docRef.id;
            } catch (error) {
              handleFirestoreError(error, OperationType.CREATE, path);
            }
          } else {
             // Local only mode
             newEvent.id = finalEventId;
             this.events.update(events => [newEvent, ...events].slice(0, 50));
          }
          this.playSound(result.type);
          
          setTimeout(() => {
             this.captureAndSaveEventVideo(feedId, finalEventId, result.description);
          }, 5000); // give 5 seconds for consequence info
        }
      }
    } catch (err: unknown) {
      const error = err as { status?: number, message?: string };
      console.error('Error analyzing temporal sequence:', error);
      
      // Graceful error handling for Rate Limits
      if (error?.status === 429 || error?.message?.includes('429') || error?.message?.includes('quota')) {
         this.updateFeed(feedId, { status: 'QUOTA_EXCEEDED', confidence: 1, isAnalyzing: false });
         
         if (this.user()) {
            const eventsRef = collection(db, 'users', this.user()!.uid, 'events');
            await addDoc(eventsRef, {
               type: 'error',
               description: 'API Quota Exceeded (429). The system is analyzing too rapidly for the current plan. Wait for limit to reset.',
               confidence: 1,
               imageUrl: lastFrameUrl,
               timestamp: serverTimestamp()
            });
         } else {
            const errorEvent: SecurityEvent = {
              id: Math.random().toString(36).substring(2, 9),
              timestamp: new Date(),
              type: 'error',
              description: 'API Quota Exceeded (429). The system is analyzing too rapidly for the current plan. Wait for limit to reset.',
              confidence: 1,
              imageUrl: lastFrameUrl
            };
            this.events.update(e => [errorEvent, ...e].slice(0, 50));
         }
         this.playSound('error');
      } else {
         this.updateFeed(feedId, { aiStage: 'Awaiting detection', isAnalyzing: false });
      }
    }
  }

  private playSound(type: string) {
    try {
      let src = '';
      if (type === 'shoplifting') {
        src = 'https://assets.mixkit.co/active_storage/sfx/995/995-preview.mp3'; // Siren/Alarm
      } else if (type === 'fall') {
        src = 'https://assets.mixkit.co/active_storage/sfx/2018/2018-preview.mp3'; // Error/Thud
      } else if (type === 'suspicious') {
        src = 'https://assets.mixkit.co/active_storage/sfx/2869/2869-preview.mp3'; // Short beep
      }
      
      if (src) {
        const audio = new Audio(src);
        audio.play().catch(e => console.log('Audio playback prevented by browser:', e));
      }
    } catch(e) {
      console.error('Failed to play sound:', e);
    }
  }
  
  toggleSettings() {
    this.showSettings.set(!this.showSettings());
  }

  setTheme(theme: 'stealth' | 'crimson' | 'cyberpunk' | 'classic') {
    this.currentTheme.set(theme);
    localStorage.setItem('clepto_trap_theme', theme);
  }

  private setupRecorder(id: string, stream: MediaStream) {
    try {
       const options = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') 
         ? { mimeType: 'video/webm;codecs=vp9' } 
         : { mimeType: 'video/webm' };
         
       const recorder = new MediaRecorder(stream, options);
       this.recorders.set(id, { recorder, chunks: [] });
       
       recorder.ondataavailable = (e) => {
          if (e.data && e.data.size > 0) {
             const state = this.recorders.get(id);
             if (state) {
                state.chunks.push(e.data);
                if (state.chunks.length > 60) {
                   state.chunks.shift(); // Keep last 60 seconds
                }
             }
          }
       };
       recorder.start(1000);
    } catch (err) {
       console.warn("MediaRecorder start failed", err);
    }
  }

  private captureAndSaveEventVideo(feedId: string, eventId: string, description: string) {
     const state = this.recorders.get(feedId);
     const chunks = state?.chunks || [];
     if (chunks.length === 0) return;

     const timestampStr = new Date().toISOString().replace(/[:.]/g, '-');

     // Save Video
     const blob = new Blob(chunks, { type: 'video/webm' });
     const videoUrl = window.URL.createObjectURL(blob);
     
     // Store video URL for local replay
     const newMap = new Map(this.videoBlobs());
     newMap.set(eventId, videoUrl);
     this.videoBlobs.set(newMap);

     if (this.autoSaveEnabled()) {
         const aVid = document.createElement('a');
         aVid.style.display = 'none';
         aVid.href = videoUrl;
         aVid.download = `CleptoTrap-Video-${timestampStr}.webm`;
         document.body.appendChild(aVid);
         aVid.click();

         // Save Text Log
         const logContent = `CLEPTO TRAP SECURITY ALERT LOG\n=================================\nTimestamp: ${new Date().toISOString()}\nFeed ID: ${feedId}\n\nEvent Description:\n${description}\n`;
         const logBlob = new Blob([logContent], { type: 'text/plain' });
         const logUrl = window.URL.createObjectURL(logBlob);
         const aLog = document.createElement('a');
         aLog.style.display = 'none';
         aLog.href = logUrl;
         aLog.download = `CleptoTrap-Log-${timestampStr}.txt`;
         document.body.appendChild(aLog);
         aLog.click();

         setTimeout(() => {
            document.body.removeChild(aVid);
            document.body.removeChild(aLog);
            window.URL.revokeObjectURL(logUrl);
            // We do not revoke videoUrl because it's used for the replay modal
         }, 1000);
     }
  }

  closeDigest() {
    this.dailyDigest.set(null);
  }

  exportEvents(format: 'json' | 'csv') {
    const events = this.events().filter(e => e.type !== 'error').map(e => ({
       id: e.id,
       timestamp: typeof e.timestamp === 'string' ? e.timestamp : new Date(e.timestamp).toISOString(),
       type: e.type,
       confidence: e.confidence,
       description: e.description
    }));
    
    if (events.length === 0) {
      return;
    }
    
    let dataUrl = '';
    let filename = '';
    
    if (format === 'json') {
       const json = JSON.stringify(events, null, 2);
       const blob = new Blob([json], { type: 'application/json' });
       dataUrl = URL.createObjectURL(blob);
       filename = `security_events_${new Date().toISOString().split('T')[0]}.json`;
    } else if (format === 'csv') {
       const header = ['id', 'timestamp', 'type', 'confidence', 'description'].join(',');
       const rows = events.map(e => [
          e.id,
          `"${e.timestamp}"`,
          e.type,
          e.confidence.toFixed(2),
          `"${e.description.replace(/"/g, '""')}"`
       ].join(','));
       const csv = [header, ...rows].join('\n');
       const blob = new Blob([csv], { type: 'text/csv' });
       dataUrl = URL.createObjectURL(blob);
       filename = `security_events_${new Date().toISOString().split('T')[0]}.csv`;
    }

    const aParams = document.createElement('a');
    aParams.style.display = 'none';
    aParams.href = dataUrl;
    aParams.download = filename;
    document.body.appendChild(aParams);
    aParams.click();
    
    setTimeout(() => {
       document.body.removeChild(aParams);
       URL.revokeObjectURL(dataUrl);
    }, 1000);
  }

  async generateDigest(timeframe: 'daily' | 'weekly' = 'daily') {
    const validEvents = this.events().filter(e => e.type !== 'error');
    if (validEvents.length === 0) {
      alert("No security events to summarize.");
      return;
    }
    
    this.isGeneratingDigest.set(true);
    try {
      const eventsText = validEvents.slice(0, 50).map(e => {
         return `Time: ${e.timestamp}, Type: ${e.type}, Confidence: ${(e.confidence * 100).toFixed(0)}%, Description: ${e.description}`;
      }).join('\n');

      const prompt = `You are a retail security AI. Generate a concise ${timeframe} security digest based on the following incident logs. Summarize key patterns, behaviors, overall risk assessment, and any actionable recommendations. Keep it professional, concise, and under 200 words. Format with simple text (no markdown formatting if not supported, but basic bold is fine).

Logs:
${eventsText}`;

      const response = await this.ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt
      });

      if (response.text) {
        this.dailyDigest.set(response.text);
      }
    } catch (e) {
      console.error("Error generating digest:", e);
      alert("Failed to generate digest. Rate limits or connectivity issue.");
    } finally {
      this.isGeneratingDigest.set(false);
    }
  }

  getEventIcon(type: string): string {
    switch(type) {
      case 'shoplifting': return 'warning';
      case 'fall': return 'personal_injury';
      case 'suspicious': return 'visibility';
      case 'error': return 'error_outline';
      default: return 'info';
    }
  }
  
  getEventColor(type: string): string {
    switch(type) {
      case 'shoplifting': return 'bg-red-100 text-red-800 border-red-200';
      case 'fall': return 'bg-orange-100 text-orange-800 border-orange-200';
      case 'suspicious': return 'bg-yellow-100 text-yellow-800 border-yellow-200';
      case 'error': return 'bg-gray-800 text-white border-gray-600';
      default: return 'bg-gray-100 text-gray-800 border-gray-200';
    }
  }

  getConfidenceBarColor(type: string): string {
    switch(type) {
      case 'shoplifting': return 'bg-red-500 shadow-[0_0_15px_rgba(239,68,68,0.8)]';
      case 'fall': return 'bg-orange-500 shadow-[0_0_15px_rgba(249,115,22,0.8)]';
      case 'suspicious': return 'bg-yellow-500 shadow-[0_0_15px_rgba(234,179,8,0.8)]';
      case 'error': return 'bg-gray-500 shadow-[0_0_15px_rgba(107,114,128,0.8)]';
      case 'QUOTA_EXCEEDED': return 'bg-purple-500 shadow-[0_0_15px_rgba(168,85,247,0.8)] animate-pulse';
      default: return 'bg-emerald-500 shadow-[0_0_15px_rgba(16,185,129,0.5)]';
    }
  }

  getConfidenceTextColor(type: string): string {
    switch(type) {
      case 'shoplifting': return 'text-red-500 drop-shadow-[0_0_8px_rgba(239,68,68,0.8)]';
      case 'fall': return 'text-orange-500 drop-shadow-[0_0_8px_rgba(249,115,22,0.8)]';
      case 'suspicious': return 'text-yellow-500 drop-shadow-[0_0_8px_rgba(234,179,8,0.8)]';
      case 'error': return 'text-gray-500 drop-shadow-[0_0_8px_rgba(107,114,128,0.8)]';
      case 'QUOTA_EXCEEDED': return 'text-purple-500 drop-shadow-[0_0_8px_rgba(168,85,247,0.8)]';
      default: return 'text-emerald-500 drop-shadow-[0_0_8px_rgba(16,185,129,0.5)]';
    }
  }
}
