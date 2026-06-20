import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = {
  whatsAppLog: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    create: vi.fn(),
    createMany: vi.fn()
  },
  whatsAppAutomation: {
    create: vi.fn()
  },
  auditLog: {
    create: vi.fn()
  }
};

vi.mock("../src/lib/prisma.js", () => ({ prisma: prismaMock }));
const sendMailMock = vi.fn();
const getCampaignAudienceMock = vi.fn();
vi.mock("../src/lib/mailer.js", () => ({ sendMail: sendMailMock }));
vi.mock("../src/lib/phase3.js", async () => {
  const actual = await vi.importActual("../src/lib/phase3.js");
  return {
    ...actual,
    getCampaignAudience: getCampaignAudienceMock
  };
});

const { registerCommunicationRoutes } = await import("../src/modules/owner/phase4/communications.js");

const buildApp = (overrides = {}) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = {
      userId: "owner-1",
      name: "Owner",
      systemRole: "SALON_USER",
      salonId: "salon-1",
      membershipId: "membership-1",
      featureFlags: {
        whatsapp: true,
        ...overrides.featureFlags
      },
      permissions: {
        whatsapp: ["view", "edit", "create"],
        ...overrides.permissions
      },
      ...overrides
    };
    req.salonId = req.user.salonId;
    next();
  });
  const router = express.Router();
  registerCommunicationRoutes(router);
  app.use("/owner", router);
  return app;
};

describe("phase4 communication routes", () => {
  beforeEach(() => {
    for (const model of Object.values(prismaMock)) {
      for (const fn of Object.values(model)) {
        fn.mockReset?.();
      }
    }
    sendMailMock.mockReset();
    getCampaignAudienceMock.mockReset();
  });

  it("updates WhatsApp log placeholder status", async () => {
    prismaMock.whatsAppLog.findFirst.mockResolvedValue({
      id: "log-1",
      salonId: "salon-1",
      metadata: null
    });
    prismaMock.whatsAppLog.update.mockResolvedValue({
      id: "log-1",
      status: "DELIVERED"
    });
    prismaMock.auditLog.create.mockResolvedValue({ id: "audit-1" });

    const response = await request(buildApp()).patch("/owner/whatsapp/logs/log-1/status").send({
      status: "DELIVERED"
    });

    expect(response.status).toBe(200);
    expect(prismaMock.whatsAppLog.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "log-1" },
      data: expect.objectContaining({
        status: "DELIVERED"
      })
    }));
  });

  it("logs a WhatsApp reply placeholder note", async () => {
    prismaMock.whatsAppLog.findFirst.mockResolvedValue({
      id: "log-1",
      salonId: "salon-1",
      metadata: null
    });
    prismaMock.whatsAppLog.update.mockResolvedValue({
      id: "log-1",
      status: "OPEN_PLACEHOLDER"
    });
    prismaMock.auditLog.create.mockResolvedValue({ id: "audit-2" });

    const response = await request(buildApp()).patch("/owner/whatsapp/logs/log-1/reply-placeholder").send({
      replyNote: "Customer asked for tomorrow slot."
    });

    expect(response.status).toBe(200);
    expect(prismaMock.whatsAppLog.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "log-1" },
      data: expect.objectContaining({
        status: "OPEN_PLACEHOLDER",
        metadata: expect.objectContaining({
          lastReplyNote: "Customer asked for tomorrow slot."
        })
      })
    }));
  });

  it("creates a WhatsApp automation with media placeholders", async () => {
    prismaMock.whatsAppAutomation.create.mockResolvedValue({
      id: "automation-1",
      mediaKind: "IMAGE",
      mediaUrl: "https://example.com/promo.jpg"
    });

    const response = await request(buildApp()).post("/owner/whatsapp/automations").send({
      eventKey: "APPOINTMENT_REMINDER",
      templateType: "appointment_reminder",
      audienceFilter: "ALL_CUSTOMERS",
      mediaKind: "IMAGE",
      mediaUrl: "https://example.com/promo.jpg",
      notes: "Send promo visual with reminder"
    });

    expect(response.status).toBe(201);
    expect(prismaMock.whatsAppAutomation.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        mediaKind: "IMAGE",
        mediaUrl: "https://example.com/promo.jpg"
      })
    }));
  });

  it("sends manual email messages through SMTP and stores an email log", async () => {
    sendMailMock.mockResolvedValue({ messageId: "smtp-1" });
    prismaMock.whatsAppLog.create.mockResolvedValue({
      id: "log-email-1",
      phone: "guest@example.com",
      metadata: { channel: "EMAIL" }
    });
    prismaMock.auditLog.create.mockResolvedValue({ id: "audit-3" });

    const response = await request(buildApp()).post("/owner/whatsapp/send-manual").send({
      channel: "EMAIL",
      email: "guest@example.com",
      templateType: "campaign_email",
      message: "Hello from salon"
    });

    expect(response.status).toBe(201);
    expect(sendMailMock).toHaveBeenCalledWith(expect.objectContaining({
      to: "guest@example.com",
      subject: "campaign_email",
      text: "Hello from salon"
    }));
    expect(prismaMock.whatsAppLog.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        phone: "guest@example.com",
        linkUrl: null,
        metadata: expect.objectContaining({
          channel: "EMAIL",
          addressType: "EMAIL"
        })
      })
    }));
  });

  it("bulk sends email campaigns to reachable audience members only", async () => {
    getCampaignAudienceMock.mockResolvedValue([
      { id: "customer-1", name: "A", email: "a@example.com", phone: "1111111111" },
      { id: "customer-2", name: "B", email: null, phone: "2222222222" },
      { id: "customer-3", name: "C", email: "c@example.com", phone: "3333333333" }
    ]);
    sendMailMock.mockResolvedValue({ ok: true });
    prismaMock.whatsAppLog.createMany.mockResolvedValue({ count: 2 });

    const response = await request(buildApp()).post("/owner/whatsapp/send-bulk-placeholder").send({
      channel: "EMAIL",
      audienceFilter: "ALL_CUSTOMERS",
      templateType: "bulk_email",
      message: "Bulk hello"
    });

    expect(response.status).toBe(200);
    expect(sendMailMock).toHaveBeenCalledTimes(2);
    expect(prismaMock.whatsAppLog.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({
          customerId: "customer-1",
          phone: "a@example.com",
          linkUrl: null,
          metadata: expect.objectContaining({ channel: "EMAIL" })
        }),
        expect.objectContaining({
          customerId: "customer-3",
          phone: "c@example.com",
          linkUrl: null,
          metadata: expect.objectContaining({ channel: "EMAIL" })
        })
      ])
    });
    expect(response.body).toEqual({ sentCount: 2 });
  });
});
