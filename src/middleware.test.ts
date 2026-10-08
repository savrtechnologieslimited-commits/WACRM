import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";

// --- Scenario knobs the mock reads -----------------------------------------
// `mockUser`         — what getUser() resolves to (a refreshed session ⇒ user,
//                      or null for the logged-out path).
// `refreshedCookies` — cookies Supabase writes via setAll() during getUser(),
//                      i.e. the freshly *rotated* auth token. The whole point
//                      of the test is that these must survive onto whatever
//                      response the middleware returns — including redirects.
let mockUser: { id: string } | null = null;
let refreshedCookies: Array<{
  name: string;
  value: string;
  options: Record<string, unknown>;
}> = [];
let configuredCookieOptions: Record<string, unknown> | undefined;
let getUserCalls = 0;

vi.mock("@supabase/ssr", () => ({
  createServerClient: (
    _url: string,
    _key: string,
    opts: {
      cookieOptions: Record<string, unknown>;
      cookies: { setAll: (c: typeof refreshedCookies) => void };
    },
  ) => {
    configuredCookieOptions = opts.cookieOptions;
    return {
      auth: {
        // Mirrors real auth-js: an expired access token is transparently
        // refreshed inside getUser(), which rotates the refresh token and
        // pushes the new cookies through setAll() before resolving.
        getUser: async () => {
          getUserCalls += 1;
          if (refreshedCookies.length) opts.cookies.setAll(refreshedCookies);
          return { data: { user: mockUser } };
        },
      },
    };
  },
}));

// Imported after the mock is registered.
const { middleware } = await import("./middleware");

beforeEach(() => {
  process.env.NEXT_PUBLIC_WHATSAPP_SUPABASE_URL = "https://test.supabase.co";
  process.env.NEXT_PUBLIC_WHATSAPP_SUPABASE_ANON_KEY = "anon-key";
  mockUser = null;
  refreshedCookies = [];
  configuredCookieOptions = undefined;
  getUserCalls = 0;
});

afterEach(() => vi.clearAllMocks());

const ROTATED = {
  name: "sb-test-auth-token",
  value: "rotated-refresh-token",
  options: { path: "/", httpOnly: true },
};

describe("middleware — refreshed auth cookies survive redirects", () => {
  it("lets the bridge replace a stale session without refreshing it first", async () => {
    const res = await middleware(
      new NextRequest("https://app.test/auth/bridge", { method: "POST" }),
    );

    expect(res.status).toBe(200);
    expect(getUserCalls).toBe(0);
  });

  it("configures partitioned cookies for embedded sessions", async () => {
    await middleware(new NextRequest("https://app.test/dashboard"));

    expect(configuredCookieOptions).toMatchObject({
      sameSite: "none",
      secure: true,
      partitioned: true,
    });
  });

  it("carries the rotated token when redirecting a signed-in user off /login", async () => {
    mockUser = { id: "user-1" };
    refreshedCookies = [ROTATED];

    const res = await middleware(
      new NextRequest("https://app.test/login"),
    );

    // Redirect to /dashboard…
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/dashboard");
    // …and the rotated cookie MUST ride along, otherwise the browser keeps
    // replaying the now-consumed refresh token and the session wedges until
    // the user manually clears cookies.
    expect(res.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
  });

  it("carries the rotated token when redirecting an unauth user to /login", async () => {
    mockUser = null;
    // Even on the logged-out path getUser() may emit cookie writes (e.g.
    // clearing a dead session); those must not be dropped on the redirect.
    refreshedCookies = [{ ...ROTATED, value: "cleared" }];

    const res = await middleware(
      new NextRequest("https://app.test/dashboard"),
    );

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login?next=%2Fdashboard");
    expect(res.cookies.get(ROTATED.name)?.value).toBe("cleared");
  });

  it("redirects a signed-in user with an invite token to /join/<token>", async () => {
    mockUser = { id: "user-1" };
    refreshedCookies = [ROTATED];

    const res = await middleware(
      new NextRequest("https://app.test/login?invite=abc123"),
    );

    expect(res.headers.get("location")).toContain("/join/abc123");
    expect(res.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
  });

  it("passes through (no redirect) for a signed-in user on a protected page", async () => {
    mockUser = { id: "user-1" };
    refreshedCookies = [ROTATED];

    const res = await middleware(
      new NextRequest("https://app.test/dashboard"),
    );

    // No redirect — the normal NextResponse.next() already carries cookies.
    expect(res.headers.get("location")).toBeNull();
    expect(res.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
  });
});

describe("middleware — every dashboard route requires a session", () => {
  // Read the route group rather than hard-coding a list, so a new page added
  // under src/app/(dashboard)/ fails here until it is added to
  // protectedPaths. /flows, /agents and /notifications were missed that way
  // and rendered a broken page to signed-out visitors instead of redirecting.
  const dashboardRoutes = readdirSync(join(__dirname, "app", "(dashboard)"), {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `/${entry.name}`);

  it("finds the dashboard route group", () => {
    expect(dashboardRoutes).toContain("/dashboard");
  });

  it.each(dashboardRoutes)("redirects a signed-out visitor from %s to /login", async (route) => {
    mockUser = null;

    const res = await middleware(
      new NextRequest(`https://app.test${route}?contact=contact-123`),
    );

    expect(res.status).toBe(307);
    const redirect = new URL(res.headers.get("location")!);
    expect(redirect.pathname).toBe("/login");
    expect(redirect.searchParams.get("next")).toBe(
      `${route}?contact=contact-123`,
    );
  });
});

describe("middleware — embedded sign-in and account recovery", () => {
  it.each(["/login", "/forgot-password", "/reset-password"])(
    "allows signed-out visitors to open %s",
    async (path) => {
      const res = await middleware(new NextRequest(`https://app.test${path}`))

      expect(res.status).toBe(200)
      expect(res.headers.get("location")).toBeNull()
    }
  )

  it("does not allow public account creation without a WACRM invitation", async () => {
    const res = await middleware(new NextRequest("https://app.test/signup"))

    expect(res.status).toBe(307)
    expect(new URL(res.headers.get("location")!).pathname).toBe("/login")
  })

  it("preserves the requested CRM destination after an existing user signs in", async () => {
    mockUser = { id: "user-1" }

    const res = await middleware(
      new NextRequest(
        "https://app.test/login?next=%2Finbox%3Fcontact%3Dcontact-123",
      ),
    )

    expect(new URL(res.headers.get("location")!).pathname).toBe("/inbox")
    expect(new URL(res.headers.get("location")!).searchParams.get("contact")).toBe(
      "contact-123",
    )
  })

  it("does not redirect sign-in to an external destination", async () => {
    mockUser = { id: "user-1" }

    const res = await middleware(
      new NextRequest("https://app.test/login?next=https%3A%2F%2Fevil.test"),
    )

    expect(new URL(res.headers.get("location")!).origin).toBe("https://app.test")
    expect(new URL(res.headers.get("location")!).pathname).toBe("/dashboard")
  })
})
