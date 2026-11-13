import { describe, expect, it } from "vitest";
import { notificationHref } from "./notification-href";
import type { Notification } from "./notifications";

const base: Notification = {
  id: "n",
  kind: "credit_denied",
  title: "t",
  body: "b",
  metadata: {},
  created_at: "2026-11-13T00:00:00Z",
  read_at: null,
  scene_id: null,
  allowance_request_id: null,
};

describe("notificationHref", () => {
  it("opens the request on /allowances when the notification belongs to one", () => {
    expect(notificationHref({ ...base, allowance_request_id: "r-1" })).toBe(
      "/allowances#request-r-1",
    );
    expect(notificationHref(base)).toBe("/allowances");
  });

  it("keeps credit_received and limit changes on /profile", () => {
    expect(notificationHref({ ...base, kind: "credit_received" })).toBe("/profile");
    expect(notificationHref({ ...base, kind: "credit_limits_changed" })).toBe("/profile");
  });
});
