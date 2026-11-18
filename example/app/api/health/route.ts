import { checkWatiConnection, configStatus } from "@/lib/config";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const connection = await checkWatiConnection();
  return Response.json({ config: configStatus(), wati: connection }, { status: connection.ok ? 200 : 503 });
}
