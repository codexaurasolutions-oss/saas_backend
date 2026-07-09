import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = {
  invoice: { findMany: vi.fn() },
  invoiceItem: { findMany: vi.fn() },
  payment: { findMany: vi.fn() },
  appointment: { findMany: vi.fn() },
  customer: { findMany: vi.fn() },
  customerMembership: { findMany: vi.fn() },
  customerPackage: { findMany: vi.fn() },
  stockMovement: { findMany: vi.fn() }
};

vi.mock("../src/lib/prisma.js", () => ({ prisma: prismaMock }));

const { reportsRouter } = await import("../src/modules/reports/routes.js");
const { errorHandler } = await import("../src/middlewares/error.js");

const buildApp = (userOverrides = {}) => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = {
      userId: "user-1",
      systemRole: "SALON_USER",
      salonId: "salon-1",
      salonRole: "MANAGER",
      membershipId: "membership-1",
      permissions: { reports: ["view"] },
      featureFlags: { reports: true },
      ...userOverrides
    };
    next();
  });
  app.use("/reports", reportsRouter);
  app.use(errorHandler);
  return app;
};

describe("reports routes", () => {
  beforeEach(() => {
    prismaMock.invoice.findMany.mockReset();
    prismaMock.invoiceItem.findMany.mockReset();
    prismaMock.payment.findMany.mockReset();
    prismaMock.appointment.findMany.mockReset();
    prismaMock.customer.findMany.mockReset();
    prismaMock.customerMembership.findMany.mockReset();
    prismaMock.customerPackage.findMany.mockReset();
    prismaMock.stockMovement.findMany.mockReset();
  });

  it("returns staff service performance rows", async () => {
    prismaMock.appointment.findMany.mockResolvedValue([]);
    prismaMock.invoice.findMany.mockResolvedValue([
      {
        id: "inv-1",
        discount: 0,
        total: 320,
        items: [
          { staffUserSalonId: "staff-1", staffName: "Ayesha", qty: 2, unitPrice: 100, lineTotal: 200, commissionAmount: 20, itemType: "SERVICE", membershipWalletUsed: 0, packageSessionsUsed: 0 },
          { staffUserSalonId: "staff-1", staffName: "Ayesha", qty: 1, unitPrice: 120, lineTotal: 120, commissionAmount: 12, itemType: "SERVICE", membershipWalletUsed: 0, packageSessionsUsed: 0 },
          { staffUserSalonId: "staff-2", staffName: "Bilal", qty: 1, unitPrice: 80, lineTotal: 80, commissionAmount: 8, itemType: "SERVICE", membershipWalletUsed: 0, packageSessionsUsed: 0 }
        ],
        customer: { id: "cust-1" }
      }
    ]);

    const response = await request(buildApp()).get("/reports/staff-services");

    expect(response.status).toBe(200);
    const ayeshaRow = response.body.find((r) => r["STAFF"] === "Ayesha");
    expect(ayeshaRow).toBeDefined();
    expect(ayeshaRow["TOTAL SERVICES DONE"]).toBe(3);
  });

  it("limits staff reports to their own scoped rows", async () => {
    prismaMock.appointment.findMany.mockResolvedValue([]);
    prismaMock.invoice.findMany.mockResolvedValue([
      {
        id: "inv-1",
        discount: 0,
        total: 150,
        items: [
          { staffUserSalonId: "membership-1", staffName: "Ayesha", qty: 1, unitPrice: 150, lineTotal: 150, commissionAmount: 15, itemType: "SERVICE", membershipWalletUsed: 0, packageSessionsUsed: 0 },
          { staffUserSalonId: "membership-2", staffName: "Bilal", qty: 1, unitPrice: 300, lineTotal: 300, commissionAmount: 30, itemType: "SERVICE", membershipWalletUsed: 0, packageSessionsUsed: 0 }
        ],
        customer: { id: "cust-1" }
      }
    ]);

    const response = await request(buildApp({ salonRole: "STAFF" })).get("/reports/staff-performance");

    expect(response.status).toBe(200);
    const staffRows = response.body.filter((r) => r["STAFF"] !== "TOTAL");
    expect(staffRows).toHaveLength(1);
    expect(staffRows[0]).toMatchObject({ "STAFF": "Ayesha" });
  });

  it("exports invoice rows as CSV", async () => {
    prismaMock.invoice.findMany.mockResolvedValue([
      {
        invoiceNumber: "INV-00001",
        status: "PAID",
        total: 500,
        paidAmount: 500,
        refundAmount: 0,
        createdAt: new Date("2026-06-01T10:00:00.000Z"),
        customer: { name: "Sara" },
        branch: { name: "Main Branch" }
      }
    ]);

    const response = await request(buildApp()).get("/reports/export.csv");

    expect(response.status).toBe(200);
    expect(response.text).toContain("INV-00001");
    expect(response.text).toContain("Sara");
    expect(response.headers["content-type"]).toMatch(/text\/csv/);
  });

  it("exports invoice rows as Excel-compatible spreadsheet", async () => {
    prismaMock.invoice.findMany.mockResolvedValue([
      {
        invoiceNumber: "INV-00002",
        status: "PARTIAL",
        total: 900,
        paidAmount: 400,
        refundAmount: 0,
        createdAt: new Date("2026-06-02T10:00:00.000Z"),
        customer: { name: "Areeba" },
        branch: { name: "North Branch" }
      }
    ]);

    const response = await request(buildApp()).get("/reports/export.xls");

    expect(response.status).toBe(200);
    expect(response.text).toContain("INV-00002");
    expect(response.text).toContain("Areeba");
    expect(response.headers["content-type"]).toMatch(/application\/vnd\.ms-excel/);
  });
});
