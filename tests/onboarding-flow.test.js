import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = {
  demoLead: {
    findUnique: vi.fn(),
    update: vi.fn()
  },
  plan: {
    findUnique: vi.fn()
  }
};

const sendMailMock = vi.fn();

vi.mock("../src/lib/prisma.js", () => ({ prisma: prismaMock }));
vi.mock("../src/lib/mailer.js", () => ({ sendMail: sendMailMock }));

const { superAdminRouter } = await import("../src/modules/superAdmin/routes.js");
const { publicRouter } = await import("../src/modules/public/routes.js");
const { errorHandler } = await import("../src/middlewares/error.js");

const buildAdminApp = () => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = {
      userId: "super-1",
      name: "Super Admin",
      systemRole: "SUPER_ADMIN"
    };
    next();
  });
  app.use("/super-admin", superAdminRouter);
  app.use(errorHandler);
  return app;
};

const buildPublicApp = () => {
  const app = express();
  app.use(express.json());
  app.use("/public", publicRouter);
  app.use(errorHandler);
  return app;
};

describe("new onboarding flow routes", () => {
  beforeEach(() => {
    sendMailMock.mockReset();
    prismaMock.demoLead.findUnique.mockReset();
    prismaMock.demoLead.update.mockReset();
    prismaMock.plan.findUnique.mockReset();
  });

  describe("Super Admin Endpoints", () => {
    it("marks a lead as contacted", async () => {
      prismaMock.demoLead.findUnique.mockResolvedValue({ id: "lead-1", status: "NEW" });
      prismaMock.demoLead.update.mockResolvedValue({ id: "lead-1", status: "CONNECTED" });

      const response = await request(buildAdminApp()).post("/super-admin/demo-leads/lead-1/contacted");

      expect(response.status).toBe(200);
      expect(response.body.status).toBe("CONNECTED");
      expect(prismaMock.demoLead.update).toHaveBeenCalledWith({
        where: { id: "lead-1" },
        data: { status: "CONNECTED" }
      });
    });

    it("schedules a walkthrough meeting and sends an invitation email", async () => {
      prismaMock.demoLead.findUnique.mockResolvedValue({ id: "lead-1", email: "qa@example.com", name: "QA Client" });
      prismaMock.demoLead.update.mockResolvedValue({ id: "lead-1", status: "IN_PROGRESS" });
      sendMailMock.mockResolvedValue({ messageId: "mail-99" });

      const response = await request(buildAdminApp())
        .post("/super-admin/demo-leads/lead-1/schedule-meeting")
        .send({
          meetingScheduledAt: "2026-08-01T12:00:00",
          meetingLink: "https://meet.google.com/xyz"
        });

      expect(response.status).toBe(200);
      expect(response.body.status).toBe("IN_PROGRESS");
      expect(prismaMock.demoLead.update).toHaveBeenCalledWith({
        where: { id: "lead-1" },
        data: {
          status: "IN_PROGRESS",
          meetingScheduledAt: new Date("2026-08-01T12:00:00"),
          meetingLink: "https://meet.google.com/xyz"
        }
      });
      expect(sendMailMock).toHaveBeenCalledWith(expect.objectContaining({
        to: "qa@example.com",
        subject: expect.stringContaining("Walkthrough")
      }));
    });

    it("sends purchase link email with correct plan details", async () => {
      prismaMock.demoLead.findUnique.mockResolvedValue({ id: "lead-1", email: "qa@example.com", name: "QA Client" });
      prismaMock.plan.findUnique.mockResolvedValue({ id: "plan-1", name: "Growth Plan", monthlyPrice: 9999 });
      prismaMock.demoLead.update.mockResolvedValue({ id: "lead-1", selectedPlanId: "plan-1" });
      sendMailMock.mockResolvedValue({ messageId: "mail-100" });

      const response = await request(buildAdminApp())
        .post("/super-admin/demo-leads/lead-1/send-purchase-link")
        .send({ planId: "plan-1" });

      expect(response.status).toBe(200);
      expect(response.body.selectedPlanId).toBe("plan-1");
      expect(prismaMock.demoLead.update).toHaveBeenCalledWith({
        where: { id: "lead-1" },
        data: { selectedPlanId: "plan-1" }
      });
      expect(sendMailMock).toHaveBeenCalledWith(expect.objectContaining({
        to: "qa@example.com",
        subject: expect.stringContaining("Subscription Plan")
      }));
    });
  });

  describe("Public/Client Checkout Endpoints", () => {
    it("retrieves checkout details for the prospect", async () => {
      prismaMock.demoLead.findUnique.mockResolvedValue({ id: "lead-1", name: "QA Client", email: "qa@example.com", company: "QA Salon" });
      prismaMock.plan.findUnique.mockResolvedValue({ id: "plan-1", name: "Growth Plan", monthlyPrice: 9999, branchLimit: 99 });

      const response = await request(buildPublicApp()).get("/public/demo-checkout-info/lead-1/plan-1");

      expect(response.status).toBe(200);
      expect(response.body.leadName).toBe("QA Client");
      expect(response.body.planName).toBe("Growth Plan");
      expect(response.body.price).toBe(9999);
    });

    it("simulates sub checkout payment completion and marks lead as paid", async () => {
      prismaMock.demoLead.findUnique.mockResolvedValue({ id: "lead-1", name: "QA Client" });
      prismaMock.demoLead.update.mockResolvedValue({ id: "lead-1", paymentCompleted: true });

      const response = await request(buildPublicApp())
        .post("/public/demo-checkout/lead-1")
        .send({ planId: "plan-1", paymentSessionId: "session-123" });

      expect(response.status).toBe(200);
      expect(response.body.lead.paymentCompleted).toBe(true);
      expect(prismaMock.demoLead.update).toHaveBeenCalledWith({
        where: { id: "lead-1" },
        data: {
          paymentCompleted: true,
          paymentSessionId: "session-123",
          selectedPlanId: "plan-1"
        }
      });
    });
  });
});
