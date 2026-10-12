import { IncomingMessage, ServerResponse } from 'node:http'

export interface ApiContext { request: IncomingMessage; response: ServerResponse; url: URL }

export function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(value))
}

export async function readJson(request: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 16_384) throw new Error('Solicitud demasiado grande')
    chunks.push(Buffer.from(chunk))
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
