import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = {
  campaign: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn()
  },
  campaignLog: {
    create: vi.fn(),
    findMany: vi.fn()
  },
  customer: {
    findMany: vi.fn()
  },
  messageTemplate: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn()
  }
};

vi.mock("../src/lib/prisma.js", () => ({ prisma: prismaMock }));

const { registerCampaignRoutes } = await import("../src/modules/owner/phase3/campaigns.js");
const { registerMessageTemplateRoutes } = await import("../src/modules/owner/phase3/message-templates.js");

const buildApp = (overrides = {}) => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = {
      userId: "owner-1",
      name: "Owner",
      systemRole: "SALON_USER",
      salonId: "salon-1",
      featureFlags: {
        campaigns: true,
        messageTemplates: true
      },
      permissions: {
        campaigns: ["view", "create", "edit"],
        messageTemplates: ["view", "edit"]
      },
      ...overrides
    };
    req.salonId = req.user.salonId;
    next();
  });
  const router = express.Router();
  registerCampaignRoutes(router);
  registerMessageTemplateRoutes(router);
  app.use("/owner", router);
  return app;
};

describe("phase3 owner routes", () => {
  beforeEach(() => {
    for (const model of Object.values(prismaMock)) {
      for (const fn of Object.values(model)) {
        fn.mockReset?.();
      }
    }
  });

  it("blocks message template routes when feature flag is disabled", async () => {
    const response = await request(buildApp({
      featureFlags: {
        campaigns: true,
        messageTemplates: false
      }
    })).get("/owner/message-templates");

    expect(response.status).toBe(403);
    expect(response.body.message).toBe("Feature disabled: messageTemplates");
    expect(prismaMock.messageTemplate.findMany).not.toHaveBeenCalled();
  });

  it("requires a service for service-based campaign creation", async () => {
    const response = await request(buildApp()).post("/owner/campaigns").send({
      name: "Service campaign",
      type: "WHATSAPP",
      audienceFilter: "SERVICE_BASED_CUSTOMERS",
      audienceMeta: {},
      message: "Hello"
    });

    expect(response.status).toBe(400);
    expect(response.body.message).toBe("Service is required for service-based campaigns");
    expect(prismaMock.campaign.create).not.toHaveBeenCalled();
  });

  it("passes campaign list and log filters to the database query", async () => {
    prismaMock.campaign.findMany.mockResolvedValue([]);
    prismaMock.campaign.findFirst.mockResolvedValue({ id: "campaign-1", salonId: "salon-1" });
    prismaMock.campaignLog.findMany.mockResolvedValue([]);

    const listResponse = await request(buildApp()).get("/owner/campaigns?q=birthday&status=SENT&type=WHATSAPP&audienceFilter=BIRTHDAY_CUSTOMERS");
    expect(listResponse.status).toBe(200);
    expect(prismaMock.campaign.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        salonId: "salon-1",
        status: "SENT",
        type: "WHATSAPP",
        audienceFilter: "BIRTHDAY_CUSTOMERS",
        OR: expect.arrayContaining([
          expect.objectContaining({ name: { contains: "birthday", mode: "insensitive" } }),
          expect.objectContaining({ message: { contains: "birthday", mode: "insensitive" } })
        ])
      })
    }));

    const logResponse = await request(buildApp()).get("/owner/campaigns/campaign-1/logs?q=sent&eventType=WHATSAPP_DISPATCHED");
    expect(logResponse.status).toBe(200);
    expect(prismaMock.campaignLog.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        campaignId: "campaign-1",
        eventType: "WHATSAPP_DISPATCHED",
        details: { contains: "sent", mode: "insensitive" }
      })
    }));
  });
});
