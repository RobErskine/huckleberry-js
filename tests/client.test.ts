import { describe, expect, it, vi } from "vitest";
import { HuckleberryClient } from "../src/client.js";
import type { FirestoreValue } from "../src/firestore.js";

function encodeValue(val: unknown): FirestoreValue {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === "boolean") return { booleanValue: val };
  if (typeof val === "number") return { doubleValue: val };
  if (typeof val === "string") return { stringValue: val };
  if (Array.isArray(val)) return { arrayValue: { values: val.map(encodeValue) } };
  const fields: Record<string, FirestoreValue> = {};
  for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
    fields[k] = encodeValue(v);
  }
  return { mapValue: { fields } };
}

function docResponse(obj: Record<string, unknown>): Response {
  const fields: Record<string, FirestoreValue> = {};
  for (const [k, v] of Object.entries(obj)) fields[k] = encodeValue(v);
  return new Response(JSON.stringify({ fields }), { status: 200 });
}

describe("authenticate", () => {
  it("stores the session and notifies onSession", async () => {
    const onSession = vi.fn();
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          idToken: "id-1",
          refreshToken: "refresh-1",
          localId: "uid-1",
          expiresIn: "3600",
        }),
        { status: 200 },
      ),
    );

    const client = new HuckleberryClient({
      fetch: fetchMock as unknown as typeof fetch,
      onSession,
    });
    const session = await client.authenticate("a@b.com", "pw");

    expect(session.uid).toBe("uid-1");
    expect(client.uid).toBe("uid-1");
    expect(onSession).toHaveBeenCalledOnce();
  });
});

describe("ensureSession", () => {
  it("refreshes a near-expired token and keeps the uid", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("securetoken")) {
        return new Response(
          JSON.stringify({
            id_token: "id-2",
            refresh_token: "refresh-2",
            expires_in: "3600",
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected url ${url}`);
    });

    const client = new HuckleberryClient({
      fetch: fetchMock as unknown as typeof fetch,
      session: {
        idToken: "id-1",
        refreshToken: "refresh-1",
        uid: "uid-1",
        expiresAt: Date.now() + 1000, // within the 5-min skew → must refresh
      },
    });

    await client.ensureSession();
    const s = client.getSession()!;
    expect(s.idToken).toBe("id-2");
    expect(s.refreshToken).toBe("refresh-2");
    expect(s.uid).toBe("uid-1");
  });
});

describe("getDashboardSummary", () => {
  it("rolls up trackers and picks the most recent feed", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes("/sleep/")) {
        return docResponse({
          timer: { active: true, paused: false, uuid: "s1" },
          prefs: { lastSleep: { start: 1000, duration: 3600, offset: -120 } },
        });
      }
      if (u.includes("/feed/")) {
        return docResponse({
          prefs: {
            lastNursing: { mode: "breast", start: 2000, duration: 600, leftDuration: 600 },
            lastBottle: { mode: "bottle", start: 5000, bottleAmount: 120, bottleUnits: "ml", bottleType: "Formula" },
            lastSolid: { mode: "solids", start: 3000 },
          },
        });
      }
      if (u.includes("/diaper/")) {
        return docResponse({
          prefs: {
            lastDiaper: { start: 4000, mode: "both" },
            lastPotty: { start: 1500, mode: "pee" },
          },
        });
      }
      if (u.includes("/pump/")) {
        return docResponse({ prefs: { lastPump: { start: 900, duration: 1200 } } });
      }
      if (u.includes("/health/")) {
        return docResponse({ prefs: { lastGrowthEntry: { mode: "growth", start: 800, offset: 0, weight: 5.2 } } });
      }
      throw new Error(`unexpected url ${u}`);
    });

    const client = new HuckleberryClient({
      fetch: fetchMock as unknown as typeof fetch,
      session: {
        idToken: "id-1",
        refreshToken: "r",
        uid: "uid-1",
        expiresAt: Date.now() + 3600_000,
      },
    });

    const summary = await client.getDashboardSummary("child1", "Baby");

    expect(summary.sleepInProgress).toBe(true);
    expect(summary.lastSleep?.start).toBe(1000);
    // bottle at 5000 is the most recent feed event
    expect(summary.lastFeed?.kind).toBe("bottle");
    expect(summary.lastFeed?.start).toBe(5000);
    expect(summary.lastFeed?.detail).toBe("120ml Formula");
    // diaper at 4000 wins over potty at 1500
    expect(summary.lastDiaper?.start).toBe(4000);
    expect(summary.lastDiaper?.mode).toBe("both");
    expect(summary.lastPump?.start).toBe(900);
    expect(summary.lastGrowth?.weight).toBe(5.2);
  });
});
