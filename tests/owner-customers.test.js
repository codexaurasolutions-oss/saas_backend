import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = {
  globalSetting: { findFirst: vi.fn() },
  subscription: { findFirst: vi.fn() },
  branch: { findFirst: vi.fn() },
  customer: {
    count: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn()
  },
  invoiceItem: { findMany: vi.fn() },
  payment: { findMany: vi.fn() }
};

vi.mock("../src/lib/prisma.js", () => ({ prisma: prismaMock }));

const { ownerRouter } = await import("../src/modules/owner/routes.js");
const { errorHandler } = await import("../src/middlewares/error.js");

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = {
      userId: "owner-user",
      name: "Owner User",
      systemRole: "SALON_USER",
      salonId: "salon-1",
      permissions: { customers: ["view", "create", "edit"] },
      featureFlags: {}
    };
    next();
  });
  app.use("/owner", ownerRouter);
  app.use(errorHandler);
  return app;
};

describe("owner customers", () => {
  beforeEach(() => {
    prismaMock.globalSetting.findFirst.mockResolvedValue(null);
    prismaMock.subscription.findFirst.mockResolvedValue(null);
    prismaMock.branch.findFirst.mockResolvedValue({
      id: "branch-1",
      salonId: "salon-1",
      isActive: true
    });
    prismaMock.customer.count.mockResolvedValue(0);
    prismaMock.customer.findFirst.mockResolvedValue(null);
    prismaMock.customer.findMany.mockResolvedValue([]);
    prismaMock.customer.create.mockImplementation(async ({ data }) => ({ id: "customer-1", ...data }));
    prismaMock.customer.update.mockImplementation(async ({ data }) => ({ id: "customer-1", salonId: "salon-1", ...data }));
    prismaMock.invoiceItem.findMany.mockResolvedValue([]);
    prismaMock.payment.findMany.mockResolvedValue([]);
  });

  it("ignores branchId when creating a customer while still validating the branch", async () => {
    const response = await request(buildApp()).post("/owner/customers").send({
      name: "Customer QA",
      phone: "03001234567",
      email: "customer@local",
      branchId: "branch-1",
      source: "Walk In"
    });

    expect(response.status).toBe(201);
    expect(prismaMock.branch.findFirst).toHaveBeenCalledWith({ where: { id: "branch-1", salonId: "salon-1", isActive: true } });
    expect(prismaMock.customer.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.not.objectContaining({ branchId: "branch-1" })
    }));
    expect(response.body.email).toBe("customer@local");
  });

  it("returns readable validation messages for invalid customer input", async () => {
    const response = await request(buildApp()).post("/owner/customers").send({
      name: "",
      phone: ""
    });

    expect(response.status).toBe(400);
    expect(response.body.message).toBe("name: Name is required");
    expect(response.body.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "name", message: "Name is required" }),
        expect.objectContaining({ field: "phone", message: "Phone must be at least 5 characters" })
      ])
    );
  });

  it("applies search and filter query params dynamically on customer listing", async () => {
    prismaMock.customer.findMany.mockResolvedValue([
      {
        id: "customer-1",
        name: "Areeba Khan",
        phone: "03001234567",
        email: "areeba@local",
        source: "Instagram",
        totalSpend: 15000,
        lastVisitAt: new Date(),
        memberships: [],
        packages: []
      }
    ]);

    const response = await request(buildApp()).get("/owner/customers?q=areeba&filter=high_spender&branchId=branch-1");

    expect(response.status).toBe(200);
    expect(prismaMock.customer.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        OR: expect.arrayContaining([
          expect.objectContaining({ name: { contains: "areeba", mode: "insensitive" } }),
          expect.objectContaining({ phone: { contains: "areeba", mode: "insensitive" } }),
          expect.objectContaining({ email: { contains: "areeba", mode: "insensitive" } }),
          expect.objectContaining({ source: { contains: "areeba", mode: "insensitive" } })
        ]),
        totalSpend: { gte: 10000 },
        invoices: { some: { branchId: "branch-1" } }
      })
    }));
    expect(response.body).toHaveLength(1);
  });
});
