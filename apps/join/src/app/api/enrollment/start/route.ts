import { proxy } from "../../../../lib/api";

export async function POST(request: Request): Promise<Response> {
  return proxy("/public/enrollment/start", await request.json());
}
