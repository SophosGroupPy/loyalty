import { proxy } from "../../../../lib/api";

export async function POST(request: Request): Promise<Response> {
  return proxy("/public/enrollment/verify", await request.json());
}
