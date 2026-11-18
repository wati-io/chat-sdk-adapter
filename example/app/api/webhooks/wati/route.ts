import { after } from "next/server";
import { getBot } from "@/lib/bot";

export const runtime = "nodejs";
// Allow time for slower handlers (e.g. the `typing` demo) to finish after the 200.
export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  if (process.env.NODE_ENV !== "production") {
    // Print each delivery while developing, to see Wati's real payloads.
    console.log("[wati webhook]", await request.clone().text());
  }
  return getBot().webhooks.wati(request, {
    waitUntil: (task) => after(() => task),
  });
}
