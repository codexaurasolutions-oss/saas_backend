import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = {
  salonSetting: {
    findFirst: vi.fn()
  },
  coupon: {
    findFirst: vi.fn()
  },
  couponRedemption: {
    count: vi.fn()
  },
  giftCard: {
    findFirst: vi.fn(),
    update: vi.fn()
  },
  giftCardRedemption: {
    create: vi.fn()
  },
  notification: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn()
  },
  auditLog: {
    findMany: vi.fn(),
    create: vi.fn()
  },
  $transaction: vi.fn(async (callback) => callback(prismaMock))
};

vi.mock("../src/lib/prisma.js", () => ({ prisma: prismaMock }));

const { registerPromotionRoutes } = await import("../src/modules/owner/phase4/promotions.js");
const { registerOperationsRoutes } = await import("../src/modules/owner/phase4/operations.js");

const buildApp = (overrides = {}) => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = {
      userId: "owner-1",
      name: "Owner",
      systemRole: "SALON_USER",
      salonId: "salon-1",
      membershipId: "membership-1",
      featureFlags: {
        couponsGiftCards: true,
        notifications: true,
        auditLogs: true,
        ...overrides.featureFlags
      },
      permissions: {
        couponsGiftCards: ["view", "create", "edit"],
        notifications: ["view", "create", "edit"],
        auditLogs: ["view"],
        ...overrides.permissions
      },
      ...overrides
    };
    req.salonId = req.user.salonId;
    next();
  });
  const router = express.Router();
  registerPromotionRoutes(router);
  registerOperationsRoutes(router);
  app.use("/owner", router);
  return app;
};

describe("phase4 owner routes", () => {
  beforeEach(() => {
    for (const model of Object.values(prismaMock)) {
      if (typeof model?.mockReset === "function") {
        model.mockReset();
        continue;
      }
      if (model && typeof model === "object") {
        for (const fn of Object.values(model)) {
          fn.mockReset?.();
        }
      }
    }
    prismaMock.$transaction.mockImplementation(async (callback) => callback(prismaMock));
    prismaMock.salonSetting.findFirst.mockResolvedValue({
      advancedSettings: {
        coupons: { enabled: true },
        giftCards: { enabled: true }
      }
    });
  });

  it("blocks notification routes when the notifications feature is disabled", async () => {
    const response = await request(buildApp({
      featureFlags: {
        couponsGiftCards: true,
        notifications: false
      }
    })).get("/owner/notifications");

    expect(response.status).toBe(403);
    expect(response.body.message).toBe("Feature disabled: notifications");
    expect(prismaMock.notification.findMany).not.toHaveBeenCalled();
  });

  it("returns an explicit valid flag when validating a coupon", async () => {
    prismaMock.coupon.findFirst.mockResolvedValue({
      id: "coupon-1",
      salonId: "salon-1",
      code: "SAVE10",
      isArchived: false,
      discountType: "PERCENT",
      discountValue: 10,
      usageLimit: null,
      usageCount: 0,
      minBillAmount: 500,
      branchId: null,
      serviceId: null,
      productId: null,
      customerUsageLimit: null,
      startsAt: null,
      endsAt: null
    });

    const response = await request(buildApp()).post("/owner/coupons/validate").send({
      code: "SAVE10",
      subtotal: 2500,
      serviceIds: [],
      productIds: []
    });

    expect(response.status).toBe(200);
    expect(response.body.valid).toBe(true);
    expect(response.body.discountAmount).toBe(250);
  });

  it("returns the updated gift card in redeem responses", async () => {
    prismaMock.giftCard.findFirst.mockResolvedValue({
      id: "gift-1",
      salonId: "salon-1",
      isActive: true,
      balanceAmount: 1000,
      expiresAt: null
    });
    prismaMock.giftCard.update.mockResolvedValue({
      id: "gift-1",
      balanceAmount: 700
    });
    prismaMock.giftCardRedemption.create.mockResolvedValue({
      id: "redeem-1",
      amountUsed: 300
    });
    prismaMock.auditLog.create.mockResolvedValue({ id: "audit-1" });

    const response = await request(buildApp()).post("/owner/gift-cards/redeem").send({
      giftCardId: "gift-1",
      amountUsed: 300
    });

    expect(response.status).toBe(201);
    expect(response.body.ok).toBe(true);
    expect(response.body.giftCard.balanceAmount).toBe(700);
    expect(response.body.redemption.amountUsed).toBe(300);
  });

  it("passes owner audit log search, module, and action filters to the database query", async () => {
    prismaMock.auditLog.findMany.mockResolvedValue([]);

    const response = await request(buildApp()).get("/owner/audit-logs?module=SETTINGS&action=SETTINGS_UPDATED&q=branch");

    expect(response.status).toBe(200);
    expect(prismaMock.auditLog.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        salonId: "salon-1",
        module: "SETTINGS",
        action: "SETTINGS_UPDATED",
        OR: expect.arrayContaining([
          expect.objectContaining({ module: { contains: "branch" } }),
          expect.objectContaining({ summary: { contains: "branch" } })
        ])
      })
    }));
  });

  it("passes notification search, type, and read-state filters to the database query", async () => {
    prismaMock.notification.findMany.mockResolvedValue([]);

    const response = await request(buildApp()).get("/owner/notifications?q=payment&type=TEST&isRead=false");

    expect(response.status).toBe(200);
    expect(prismaMock.notification.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        salonId: "salon-1",
        type: "TEST",
        isRead: false,
        AND: expect.arrayContaining([
          expect.objectContaining({
            OR: expect.arrayContaining([
              expect.objectContaining({ userSalonId: null }),
              expect.objectContaining({ userSalonId: "membership-1" })
            ])
          }),
          expect.objectContaining({
            OR: expect.arrayContaining([
              expect.objectContaining({ title: { contains: "payment" } }),
              expect.objectContaining({ message: { contains: "payment" } })
            ])
          })
        ])
      })
    }));
  });

  it("marks a single owner notification as read", async () => {
    prismaMock.notification.findFirst.mockResolvedValue({
      id: "note-1",
      salonId: "salon-1",
      userSalonId: "membership-1",
      isRead: false
    });
    prismaMock.notification.update.mockResolvedValue({
      id: "note-1",
      isRead: true
    });

    const response = await request(buildApp()).patch("/owner/notifications/note-1/read");

    expect(response.status).toBe(200);
    expect(prismaMock.notification.update).toHaveBeenCalledWith({
      where: { id: "note-1" },
      data: { isRead: true }
    });
    expect(response.body.isRead).toBe(true);
  });
});
