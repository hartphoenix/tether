import { basename } from "node:path";
import type { DocumentService, DocumentSession } from "../documents/document-service";
import type { RecentsService } from "../recents/service";
import type { ReaderBackend, ReaderConnection } from "../remote/contracts";
import type { AppPreferences } from "../shared/contracts";
import { INPUT_LIMITS, invalidRequest, validateControlInput } from "../shared/control-input";
import { folioHtml, folioTheme } from "../web/folio-page";
import { linkFragment } from "../shared/link-fragment";
import { imageResponse } from "../documents/image-assets";

type Options = {
  service: DocumentService;
  recents: RecentsService;
  instanceId: string;
  documentOperation: (route: string, body: Record<string, unknown>) => Promise<unknown>;
  reader: (grant: DocumentSession) => ReaderConnection;
  preferences: (themeClient?: string) => Promise<AppPreferences>;
  previewAppearance?: (body: Record<string, unknown>) => void;
  observeTheme?: (clientId: string, theme: unknown) => Promise<void>;
  saveAppearance: (body: Record<string, unknown>, themeClient?: string) => Promise<unknown>;
  assets: (request: Request) => Response | Promise<Response>;
};

const fail = (code: string, message: string, status = 400) => Object.assign(new Error(message), { code, status });
const json = (value: unknown) => Response.json(value, { headers: { "cache-control": "no-store" } });
const sharedThemeClient = (request: Request): string | undefined => {
  const value = request.headers.get("x-tether-shared-theme") ?? request.headers.get("cookie")?.split(";").map(item => item.trim()).find(item => item.startsWith("__Host-tether-shared-theme="))?.split("=")[1];
  return value && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value) ? value : undefined;
};
const documentRoute = (id: string) => `/reader/d/${encodeURIComponent(id)}/`;

/** Public library policy reuses the daemon's document operations and reader. */
export function createSharedLibrary(options: Options) {
  const { service, recents } = options;
  const refs = (body: Record<string, unknown>) => {
    const ids = Array.isArray(body.documentIds) ? body.documentIds : typeof body.documentId === "string" ? [body.documentId] : [];
    if (ids.length > 200 || ids.some(id => typeof id !== "string" || !service.store.documentById(id))) throw invalidRequest("Select registered document IDs.");
    return (ids as string[]).map(documentId => ({ documentId }));
  };
  const register = async (body: Record<string, unknown>) => {
    if (typeof body.path !== "string" || typeof body.machineId !== "string") throw invalidRequest("A machine ID and Markdown path are required.");
    const grant = await service.openLocation(body.machineId, body.path, { restoreArchived: body.restoreArchived === true });
    try {
      const registration = await recents.recordDocument(grant.documentId!);
      return { documentId: grant.documentId, machineId: grant.machineId, path: grant.path, url: documentRoute(grant.documentId!), registration: { entry: registration.entry, hostSynchronized: registration.hostSynchronized, hostSyncStatus: registration.hostSyncStatus } };
    } finally { service.close(grant); }
  };

  async function dispatch(operation: string, body: Record<string, unknown>): Promise<unknown> {
    const route = `/control/${operation.replaceAll(".", "/")}`;
    validateControlInput(body, route);
    if (["document.save", "document.verify-save"].includes(operation) && (!Number.isSafeInteger(body.expectedLocationVersion) || Number(body.expectedLocationVersion) < 1)) throw invalidRequest("The location version returned by document read is required for this save.");
    if (operation === "document.register") return register(body);
    if (operation === "document.history") {
      if (typeof body.documentId !== "string") throw invalidRequest("A document ID is required.");
      return service.history(body.documentId, body);
    }
    if (operation === "document.restore") {
      const selected = refs(body);
      if (!selected.length) throw invalidRequest("A document ID is required.");
      return recents.restore(selected);
    }
    if (operation === "document.relink") {
      if (typeof body.documentId !== "string" || typeof body.machineId !== "string" || typeof body.path !== "string") throw invalidRequest("Relink requires document ID, machine ID and path.");
      const result = await service.relink(body.documentId, body.machineId, body.path);
      await recents.refresh();
      return result;
    }
    if (operation === "document.verify-save") {
      if (typeof body.documentId !== "string" || typeof body.body !== "string" || typeof body.expectedBodyRevision !== "string") throw invalidRequest("Verification requires document ID, attempted body and base revision.");
      const grant = await service.openById(body.documentId);
      try {
        if (body.expectedLocationVersion !== grant.locationVersion) throw fail("stale_location", "The document location changed. Reopen it before verifying this save.", 409);
        await service.barrier(grant);
        const current = await service.read(grant);
        return {
          outcome: current.body === body.body ? "matches_edit" : current.bodyRevision === body.expectedBodyRevision ? "matches_base" : "diverged",
          documentId: current.documentId, machineId: current.machineId, locationVersion: current.locationVersion,
          path: current.path, bodyRevision: current.bodyRevision, conversationRevision: current.ledgerRevision,
        };
      } finally { service.close(grant); }
    }
    if (/^(document\.(read|save|outline|context|diff)|review\.(pending|threads|thread|event|quote-candidates|operation|comment|reply|resolve|reopen|edit|delete|acknowledge))$/.test(operation)) return options.documentOperation(route, body);
    if (operation === "folio.list") return { ...await recents.folioSnapshot(body), instanceId: options.instanceId };
    if (operation === "folio.add") return register(body);
    const selected = refs(body);
    if (operation === "folio.restore") return recents.restore(selected);
    if (operation === "folio.archive" || operation === "folio.clear-unpinned") {
      if ((await recents.getRetention()).mode === "immediate" && body.confirmed !== true) throw fail("confirmation_required", "Confirm deleting the archived data.", 409);
      return operation === "folio.archive" ? recents.archive(selected) : recents.clearUnpinned();
    }
    if (operation === "folio.pin" || operation === "folio.unpin") return recents.setPinned(selected, operation === "folio.pin" && body.pinned !== false);
    if (operation === "folio.delete" || operation === "folio.delete-conversation") {
      if (body.confirmed !== true) throw fail("confirmation_required", "Confirm deleting the selected conversations.", 409);
      return operation === "folio.delete" ? recents.delete(selected) : recents.deleteConversation(selected);
    }
    if (operation === "folio.remove-entry") return recents.delete(selected, undefined, true);
    if (operation === "folio.export") {
      const grants: DocumentSession[] = [];
      try { for (const ref of selected) grants.push(await service.openById(ref.documentId, { existingReader: true })); return await service.exportReviews(grants); }
      finally { for (const grant of grants) service.close(grant); }
    }
    if (operation === "folio.settings") {
      if (body.retention === undefined) return { retention: await recents.getRetention() };
      if (body.confirmed !== true) throw fail("confirmation_required", "Confirm the archive retention change.", 409);
      return recents.setRetention(body.retention as Parameters<RecentsService["setRetention"]>[0]);
    }
    throw fail("unsupported_operation", "This operation is unavailable through the shared library.", 404);
  }

  const reader: ReaderBackend = {
    list: async () => (await recents.folioSnapshot({ view: "all" })).files.map(file => ({ id: file.id, title: file.name, directory: file.directory, view: file.view, pinned: file.pinned, attentionCount: file.attentionCount, opened: file.openedAt, modified: file.modifiedAt ?? 0, activity: file.activityAt ?? 0, unavailable: file.missing || !!file.fileIssue, machineId: file.machineId })),
    member: async id => {
      const row = service.store.documentById(id);
      return row ? { id, title: row.title ?? basename(row.path) } : null;
    },
    open: async (id, openOptions) => {
      const grant = await service.openById(id, { existingReader: openOptions?.resume === true });
      if (!openOptions?.resume) await recents.recordDocument(id);
      const upstream = options.reader(grant);
      return {
        close: () => upstream.close(),
        request: async (resource, request) => {
          const pathname = resource.split("?", 1)[0];
          const version = request.headers.get("x-tether-location-version") ?? new URL(request.url).searchParams.get("locationVersion");
          if (version !== null && Number(version) !== grant.locationVersion) throw fail("stale_location", "The document location changed. Reopen this reader.", 409);
          if ((pathname === "api/file" && request.method === "PUT" || pathname === "api/verify-save" && request.method === "POST") && version === null) throw invalidRequest("A reader location version is required.");
          if (pathname === "api/folio" && request.method === "GET") return json(await reader.list!());
          if (pathname === "api/history" && request.method === "GET") {
            const query: Record<string, unknown> = Object.fromEntries(new URL(request.url).searchParams);
            for (const field of ["limit", "maxBytes", "beforeSequence"]) if (query[field] !== undefined) query[field] = Number(query[field]);
            validateControlInput(query, "/review/history");
            return json(service.history(id, query));
          }
          if (pathname === "api/verify-save" && request.method === "POST") {
            const body = await boundedBody(request);
            if (typeof body.body !== "string" || typeof body.expectedBodyRevision !== "string") throw invalidRequest("Verification requires attempted text and base revision.");
            await service.barrier(grant);
            const current = await service.read(grant);
            return json({ outcome: current.body === body.body ? "matches_edit" : current.bodyRevision === body.expectedBodyRevision ? "matches_base" : "diverged", document: current });
          }
          if (pathname === "api/draft") return json({ saved: false, persistent: false });
          if (pathname === "api/position") return json({ saved: false, local: true });
          if (pathname === "api/image" && request.method === "GET") {
            const asset = await service.image(grant, new URL(request.url).searchParams.get("src") ?? "");
            return imageResponse(asset, request);
          }
          if (pathname === "api/open" || pathname === "api/link") {
            const body = request.method === "GET" ? Object.fromEntries(new URL(request.url).searchParams) : await boundedBody(request);
            if (typeof body.target !== "string") throw invalidRequest("A link target is required.");
            const format = body.format === "markdown" ? "markdown" : "wikilink";
            let destination: DocumentSession;
            try { destination = await service.resolveLink(grant, body.target, format, { restoreArchived: body.restoreArchived === true }); }
            catch (cause) {
              const failure = cause as {code?:string;details?:{documentId?:string}};
              if (request.method === "GET" && failure.code === "restore_required" && failure.details?.documentId) return new Response(null, { status: 303, headers: { location: documentRoute(failure.details.documentId) } });
              throw cause;
            }
            try {
              await recents.recordDocument(destination.documentId!);
              const url = documentRoute(destination.documentId!) + linkFragment(body.target, format);
              return request.method === "GET" ? new Response(null, { status: 303, headers: { location: url, "cache-control": "no-store" } }) : json({ url, opened: false });
            } finally { service.close(destination); }
          }
          if (/^api\/(updates|file\/(move|reveal)|theme-events)/.test(pathname!)) throw fail("unsupported_operation", "This operation requires a local host.", 404);
          if (pathname === "api/preferences") {
            if (request.method === "GET") return json(await options.preferences(sharedThemeClient(request)));
            if (request.method === "PUT") return json(await options.saveAppearance(await boundedBody(request), sharedThemeClient(request)));
          }
          const response = await upstream.request(resource, request);
          if (pathname === "api/bootstrap" && response.ok) {
            const value = await response.json();
            return json({ ...value, preferences: await options.preferences(sharedThemeClient(request)), sharedReader: true, remoteReader: true, draft: null, directoryPicker: false, capabilities: { pageOpensLinks: true, pageFind: true }, updateControls: false, document: { ...value.document, documentId: id, machineId: grant.machineId, locationVersion: grant.locationVersion, bodyEditable: true } });
          }
          return response;
        },
      };
    },
  };

  async function page(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/assets/") || url.pathname === "/favicon.png") return options.assets(request);
    if (url.pathname === "/settings") return new Response(null, { status: 303, headers: { location: "/settings/" } });
    if (url.pathname === "/" || url.pathname === "/folio") return new Response(null, { status: 303, headers: { location: "/folio/" } });
    if (["/folio/", "/settings/"].includes(url.pathname) && request.method === "GET") {
      const prefs = await options.preferences(sharedThemeClient(request));
      return new Response(folioHtml({ settingsOnly: url.pathname === "/settings/", embedded: url.searchParams.get("embedded") === "1", apiBase: "/folio/api", shared: true, pickerAvailable: true, locateFiles: true, importPackages: false, exportPackages: true, serviceControls: false, ...prefs }), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    }
    if (!url.pathname.startsWith("/folio/api/")) return null;
    const action = url.pathname.slice("/folio/api/".length);
    const prefs = async () => { const value = await options.preferences(sharedThemeClient(request)); return { ...value, ...folioTheme({ theme: value.theme, design: value.customThemes?.find(t => t.id === value.theme) }) }; };
    if (request.method === "GET" && action === "snapshot") return json({ ...await recents.folioSnapshot({ view: "all" }), instanceId: options.instanceId, preferences: await prefs() });
    if (request.method === "GET" && action === "preferences") return json(await prefs());
    if (request.method !== "POST") throw fail("unsupported_operation", "Unknown Folio operation.", 404);
    const body = await boundedBody(request);
    if (action === "preferences") return json(await options.saveAppearance(body, sharedThemeClient(request)));
    if (action === "preferences-preview") { options.previewAppearance?.(body); return json({ previewed: true }); }
    if (action === "lease") return json({ ok: true });
    if (action === "filters") {
      if (!["save", "set-active", "delete"].includes(String(body.action)) || typeof body.text !== "string" || body.text.length > 1000 || !body.text.trim()) throw invalidRequest("Invalid saved filter.");
      return json(await recents.changeFilter(body.action as "save" | "set-active" | "delete", body.text, body.active as boolean));
    }
    if (action === "open") {
      if (typeof body.documentId !== "string") throw invalidRequest("A document ID is required.");
      const grant = await service.openById(body.documentId, { restoreArchived: body.restoreArchived === true });
      service.close(grant);
      return json({ url: documentRoute(body.documentId) });
    }
    if (action === "pick") return json(await register(body));
    if (action === "relink") return json(await dispatch("document.relink", body));
    if (action === "action" || action === "batch") return json(await dispatch(`folio.${body.action}`, body));
    if (action === "settings" || action === "clear-unpinned") return json(await dispatch(`folio.${action}`, body));
    throw fail("unsupported_operation", "Unknown Folio operation.", 404);
  }
  return { dispatch, reader, page, observeTheme: options.observeTheme, subscribe: (listener: () => void) => recents.subscribeFolio(listener) };
}

async function boundedBody(request: Request): Promise<Record<string, unknown>> {
  const chunks: Uint8Array[] = []; let size = 0;
  if (request.body) for await (const chunk of request.body) {
    size += chunk.length;
    if (size > INPUT_LIMITS.markdown + 1024 * 1024) throw fail("request_too_large", "Request exceeds its byte limit.", 413);
    chunks.push(chunk);
  }
  let body: unknown;
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw invalidRequest("Invalid JSON request."); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw invalidRequest("Expected a request object.");
  return body as Record<string, unknown>;
}
