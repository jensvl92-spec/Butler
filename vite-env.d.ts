declare global {
  interface Window {
    SpeechRecognition: any
    webkitSpeechRecognition: any
  }
}

interface ImportMeta {
  env: {
    VITE_SUPABASE_URL: string
    VITE_SUPABASE_SUPABASE_ANON_KEY: string
  }
}

export {}
