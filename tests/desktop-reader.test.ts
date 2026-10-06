import { expect, test } from "bun:test";
import { DesktopReaderBackend } from "../src/remote/desktop-reader";
import type { ReaderBackend } from "../src/remote/contracts";
import { resolveConfig } from "../src/server/config";
import type { controlRequest } from "../src/server/lifecycle";

const documentId = "11111111-1111-4111-8111-111111111111";
const member = { id: documentId, path: "/same/document.md", title: "Document" };
const assets: ReaderBackend = { list: async () => [], member: async () => null, open: async () => { throw new Error("Assets must not open before desktop launch validation."); } };

function backend(record: unknown, launchError?: Error) {
  const launches:unknown[] = [];
  const request = (async (_config:unknown, route:string, input:unknown) => {
    if (route === "/control/folio/member") return record;
    if (route === "/control/launch") {
      launches.push(input);
      if (launchError) throw launchError;
      // Stop before network access; this test exercises daemon negotiation only.
      return { revocable:false, url:"http://127.0.0.1/launch" };
    }
    throw new Error(`Unexpected route: ${route}`);
  }) as typeof controlRequest;
  return { reader: new DesktopReaderBackend(resolveConfig(),assets,"initial",request), launches };
}

test("legacy local-only desktop launches the verified Folio member path", async () => {
  const {reader,launches} = backend(member);
  await expect(reader.open(documentId)).rejects.toThrow("revocable phone sessions");
  expect(launches).toEqual([{path:member.path,target:{host:"browser"}}]);
});

test("machine-aware desktop uses UUID for every machine and never retries a failed remote launch by path", async () => {
  for (const machineId of ["local-machine","remote-machine"]) {
    const {reader,launches} = backend({...member,machineId},new Error("Document unavailable"));
    await expect(reader.open(documentId)).rejects.toThrow("Document unavailable");
    expect(launches).toEqual([{documentId,target:{host:"browser"}}]);
  }
});

test("malformed machine identity cannot activate the legacy path fallback", async () => {
  for (const machineId of [undefined,null,""]) {
    const {reader,launches} = backend({...member,machineId});
    await expect(reader.open(documentId)).rejects.toThrow("Invalid desktop machine identity");
    expect(launches).toEqual([]);
  }
});

test("desktop proxy preserves the original location version and supplies its own session authority", async () => {
  const server = Bun.serve({hostname:"127.0.0.1",port:0,fetch:request => new URL(request.url).pathname === "/launch"
    ? new Response(null,{status:302,headers:{location:"/s/desktop-session/","set-cookie":"tether_session=desktop; HttpOnly"}})
    : Response.json({version:request.headers.get("x-tether-location-version"),etag:request.headers.get("if-none-match"),authorization:request.headers.get("authorization"),cookie:request.headers.get("cookie"),origin:request.headers.get("origin")})});
  const revoked:unknown[] = [];
  const requestControl = (async (_config:unknown, route:string, input:unknown) => {
    if (route === "/control/folio/member") return {...member,machineId:"remote-machine"};
    if (route === "/control/launch") return {revocable:true,url:`${server.url.origin}/launch`};
    if (route === "/control/session/revoke") { revoked.push(input); return {}; }
    throw new Error(`Unexpected route: ${route}`);
  }) as typeof controlRequest;
  const frontend = {...assets,open:async () => ({request:async () => new Response("assets"),close:async () => {}})};
  try {
    const reader = new DesktopReaderBackend(resolveConfig(),frontend,"initial",requestControl), connection = await reader.open(documentId);
    const response = await connection.request("api/file",new Request("https://phone.example/api/file",{method:"PUT",headers:{"x-tether-location-version":"17","if-none-match":"body-revision",authorization:"Bearer caller",cookie:"untrusted",origin:"https://phone.example"},body:"{}"}));
    expect(await response.json()).toEqual({version:"17",etag:"body-revision",authorization:null,cookie:"tether_session=desktop",origin:server.url.origin});
    await connection.close(); expect(revoked).toEqual([{id:"desktop-session"}]);
  } finally { await server.stop(true); }
});
