
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

serve(async (req) => {
    return new Response(
        JSON.stringify({
            error: "DEPRECATED",
            message: "This function has been replaced by the local Butler Crew. Please update your app."
        }),
        {
            status: 410,
            headers: { "Content-Type": "application/json" },
        }
    );
});
