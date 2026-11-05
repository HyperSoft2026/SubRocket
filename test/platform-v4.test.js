"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { applyLedgerEntry, ROLE_PERMISSIONS } = require("../platform-v4");

function mockClient(insertResult, updateResult) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes("INSERT INTO points_ledger")) return insertResult;
      if (sql.includes("UPDATE users SET points=points+")) return updateResult;
      throw new Error("Unexpected SQL: " + sql);
    }
  };
}

test("ledger applies a new idempotent credit exactly once", async () => {
  const client = mockClient({ rowCount: 1, rows: [{ id: 9 }] }, { rowCount: 1, rows: [{ points: "150" }] });
  const result = await applyLedgerEntry(client, { userId: "123", amount: "50", reason: "test", idempotencyKey: "test-credit-1" });
  assert.equal(result.applied, true);
  assert.equal(result.points, "150");
  assert.equal(client.calls.length, 2);
});

test("ledger duplicate does not update user balance again", async () => {
  const client = mockClient({ rowCount: 0, rows: [] }, { rowCount: 1, rows: [{ points: "150" }] });
  const result = await applyLedgerEntry(client, { userId: "123", amount: "50", reason: "test", idempotencyKey: "test-credit-1" });
  assert.equal(result.duplicate, true);
  assert.equal(client.calls.length, 1);
});

test("ledger rejects zero, non-integer and missing idempotency keys", async () => {
  const client = mockClient({ rowCount: 1, rows: [] }, { rowCount: 1, rows: [] });
  await assert.rejects(() => applyLedgerEntry(client, { userId: "123", amount: "0", reason: "test", idempotencyKey: "x" }));
  await assert.rejects(() => applyLedgerEntry(client, { userId: "123", amount: "1.5", reason: "test", idempotencyKey: "x" }));
  await assert.rejects(() => applyLedgerEntry(client, { userId: "123", amount: "1", reason: "test" }));
  assert.equal(client.calls.length, 0);
});

test("ledger fails safely on insufficient balance or missing user", async () => {
  const client = mockClient({ rowCount: 1, rows: [{ id: 1 }] }, { rowCount: 0, rows: [] });
  await assert.rejects(() => applyLedgerEntry(client, { userId: "123", amount: "-10", reason: "debit", idempotencyKey: "debit-1" }), /insufficient balance/);
});

test("staff role permissions are least-privilege by default", () => {
  assert.ok(ROLE_PERMISSIONS.support.includes("support.reply"));
  assert.ok(!ROLE_PERMISSIONS.support.includes("wallet.adjust"));
  assert.ok(ROLE_PERMISSIONS.analyst.includes("analytics.read"));
  assert.ok(!ROLE_PERMISSIONS.analyst.includes("staff.manage"));
  assert.ok(!ROLE_PERMISSIONS.moderator.includes("settings.manage"));
});
