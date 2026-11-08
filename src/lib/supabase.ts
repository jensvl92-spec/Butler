import { createClient } from '@supabase/supabase-js'

const DEFAULT_SUPABASE_URL = 'https://rbriqijzyptjwsjrsqvc.supabase.co'
const DEFAULT_SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJicmlxaWp6eXB0andzanJzcXZjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjUyMjY3MDgsImV4cCI6MjA4MDgwMjcwOH0.94wS30fbBgNXqtO4zqTAFPa7XVs7CEaegAwVu6nMk40'

const supabaseUrl = ((import.meta as any).env?.VITE_SUPABASE_URL as string) || DEFAULT_SUPABASE_URL
const supabaseAnonKey = ((import.meta as any).env?.VITE_SUPABASE_ANON_KEY as string) || DEFAULT_SUPABASE_ANON_KEY

export const supabase = createClient(supabaseUrl, supabaseAnonKey)

