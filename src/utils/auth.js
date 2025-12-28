import { supabase } from '../lib/supabase';
export async function signUp(email, password) {
    return supabase.auth.signUp({ email, password });
}
export async function signIn(email, password) {
    return supabase.auth.signInWithPassword({ email, password });
}
export async function signOut() {
    return supabase.auth.signOut();
}
export async function getCurrentUser() {
    const { data } = await supabase.auth.getUser();
    return data?.user;
}
export function onAuthStateChange(callback) {
    const { data: { subscription }, } = supabase.auth.onAuthStateChange((_event, session) => {
        callback(session);
    });
    return subscription;
}
