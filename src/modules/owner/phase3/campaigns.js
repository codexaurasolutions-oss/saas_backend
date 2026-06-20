import { prisma } from "../../../lib/prisma.js";
import { buildCsv } from "../../../lib/phase2.js";
import { dispatchCampaign } from "../../../lib/emailAutomation.js";
import { getCampaignAudience } from "../../../lib/phase3.js";
import { requireFeatureEnabled, requireSalonPermission } from "../../../middlewares/rbac.js";
import { schemas, validate } from "../../../middlewares/validate.js";

const includeCampaign = {
  logs: { orderBy: { createdAt: "desc" } }
};

export const registerCampaignRoutes = (ownerRouter) => {
  const getCampaignAudienceMetaError = (body) => {
    if (body.audienceFilter === "SERVICE_BASED_CUSTOMERS" && !body.audienceMeta?.serviceId) {
      return "Service is required for service-based campaigns";
    }
    return null;
  };

  const splitAudienceByReachability = (campaign, audience) => {
    const reachable = [];
    const unreachable = [];
    for (const customer of audience) {
      const hasEmail = Boolean(customer.email);
      const hasPhone = Boolean(customer.phone);
      const canReceive = campaign.type === "EMAIL"
        ? hasEmail
        : campaign.type === "SMS" || campaign.type === "WHATSAPP"
          ? hasPhone
          : true;

      if (canReceive) {
        reachable.push(customer);
      } else {
        unreachable.push({
          id: customer.id,
          name: customer.name,
          reason: campaign.type === "EMAIL" ? "Missing email address" : "Missing phone number"
        });
      }
    }
    return { reachable, unreachable };
  };

  ownerRouter.get("/campaigns", requireFeatureEnabled("campaigns"), requireSalonPermission("campaigns", "view"), async (req, res) => {
    const q = String(req.query.q || "").trim();
    const status = String(req.query.status || "").trim();
    const type = String(req.query.type || "").trim();
    const audienceFilter = String(req.query.audienceFilter || "").trim();
    res.json(await prisma.campaign.findMany({
      where: {
        salonId: req.salonId,
        ...(status ? { status } : {}),
        ...(type ? { type } : {}),
        ...(audienceFilter ? { audienceFilter } : {}),
        ...(q ? {
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { message: { contains: q, mode: "insensitive" } },
            { type: { contains: q, mode: "insensitive" } },
            { audienceFilter: { contains: q, mode: "insensitive" } }
          ]
        } : {})
      },
      include: includeCampaign,
      orderBy: { createdAt: "desc" }
    }));
  });
  ownerRouter.post("/campaigns", requireFeatureEnabled("campaigns"), requireSalonPermission("campaigns", "create"), validate(schemas.campaign), async (req, res) => {
    const audienceMetaError = getCampaignAudienceMetaError(req.body);
    if (audienceMetaError) return res.status(400).json({ message: audienceMetaError });
    const audience = await getCampaignAudience(req.salonId, req.body.audienceFilter, req.body.audienceMeta || {});
    const created = await prisma.campaign.create({
      data: {
        salonId: req.salonId,
        name: req.body.name,
        type: req.body.type,
        status: req.body.scheduledFor ? "SCHEDULED" : "DRAFT",
        audienceFilter: req.body.audienceFilter,
        audienceMeta: { ...(req.body.audienceMeta || {}), audienceCount: audience.length },
        message: req.body.message || null,
        bannerUrl: req.body.bannerUrl || null,
        scheduledFor: req.body.scheduledFor ? new Date(req.body.scheduledFor) : null,
        logs: {
          create: {
            eventType: "CREATED",
            details: `Audience count: ${audience.length}`
          }
        }
      },
      include: includeCampaign
    });
    res.status(201).json(created);
  });
  ownerRouter.get("/campaigns/:id", requireFeatureEnabled("campaigns"), requireSalonPermission("campaigns", "view"), async (req, res) => {
    const row = await prisma.campaign.findFirst({ where: { id: req.params.id, salonId: req.salonId }, include: includeCampaign });
    if (!row) return res.status(404).json({ message: "Campaign not found" });
    const audience = await getCampaignAudience(req.salonId, row.audienceFilter, row.audienceMeta || {});
    const { reachable, unreachable } = splitAudienceByReachability(row, audience);
    res.json({
      ...row,
      audiencePreview: reachable.slice(0, 20),
      reachableAudienceCount: reachable.length,
      unreachableAudienceCount: unreachable.length,
      unreachablePreview: unreachable.slice(0, 20)
    });
  });
  ownerRouter.patch("/campaigns/:id", requireFeatureEnabled("campaigns"), requireSalonPermission("campaigns", "edit"), validate(schemas.campaign), async (req, res) => {
    const audienceMetaError = getCampaignAudienceMetaError(req.body);
    if (audienceMetaError) return res.status(400).json({ message: audienceMetaError });
    const row = await prisma.campaign.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
    if (!row) return res.status(404).json({ message: "Campaign not found" });
    const audience = await getCampaignAudience(req.salonId, req.body.audienceFilter, req.body.audienceMeta || {});
    const updated = await prisma.campaign.update({
      where: { id: row.id },
      data: {
        name: req.body.name,
        type: req.body.type,
        audienceFilter: req.body.audienceFilter,
        audienceMeta: { ...(req.body.audienceMeta || {}), audienceCount: audience.length },
        message: req.body.message || null,
        bannerUrl: req.body.bannerUrl || null,
        scheduledFor: req.body.scheduledFor ? new Date(req.body.scheduledFor) : null
      },
      include: includeCampaign
    });
    await prisma.campaignLog.create({ data: { campaignId: row.id, eventType: "UPDATED", details: `Audience count: ${audience.length}` } });
    res.json(updated);
  });
  ownerRouter.post("/campaigns/:id/duplicate", requireFeatureEnabled("campaigns"), requireSalonPermission("campaigns", "create"), async (req, res) => {
    const row = await prisma.campaign.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
    if (!row) return res.status(404).json({ message: "Campaign not found" });
    const created = await prisma.campaign.create({
      data: {
        salonId: req.salonId,
        name: `${row.name} Copy`,
        type: row.type,
        status: "DRAFT",
        audienceFilter: row.audienceFilter,
        audienceMeta: row.audienceMeta || null,
        message: row.message,
        bannerUrl: row.bannerUrl,
        logs: { create: { eventType: "DUPLICATED", details: `Duplicated from ${row.id}` } }
      },
      include: includeCampaign
    });
    res.status(201).json(created);
  });
  ownerRouter.post("/campaigns/:id/schedule", requireFeatureEnabled("campaigns"), requireSalonPermission("campaigns", "edit"), validate(schemas.campaignAction), async (req, res) => {
    const row = await prisma.campaign.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
    if (!row) return res.status(404).json({ message: "Campaign not found" });
    const scheduledFor = req.body.scheduledFor ? new Date(req.body.scheduledFor) : new Date();
    const updated = await prisma.campaign.update({
      where: { id: row.id },
      data: { status: "SCHEDULED", scheduledFor }
    });
    await prisma.campaignLog.create({ data: { campaignId: row.id, eventType: "SCHEDULED", details: `Scheduled for ${scheduledFor.toISOString()}` } });
    res.json(updated);
  });
  ownerRouter.post("/campaigns/:id/send-placeholder", requireFeatureEnabled("campaigns"), requireSalonPermission("campaigns", "edit"), async (req, res) => {
    const row = await prisma.campaign.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
    if (!row) return res.status(404).json({ message: "Campaign not found" });
    const result = await dispatchCampaign({
      salonId: req.salonId,
      campaignId: row.id,
      actorUserId: req.user.userId,
      actorMembershipId: req.user.membershipId
    });
    res.json(result);
  });
  ownerRouter.get("/campaigns/:id/logs", requireFeatureEnabled("campaigns"), requireSalonPermission("campaigns", "view"), async (req, res) => {
    const row = await prisma.campaign.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
    if (!row) return res.status(404).json({ message: "Campaign not found" });
    const q = String(req.query.q || "").trim();
    const eventType = String(req.query.eventType || "").trim();
    res.json(await prisma.campaignLog.findMany({
      where: {
        campaignId: row.id,
        ...(eventType ? { eventType } : {}),
        ...(q ? { details: { contains: q, mode: "insensitive" } } : {})
      },
      orderBy: { createdAt: "desc" }
    }));
  });
  ownerRouter.get("/campaigns/:id/logs/export.csv", requireFeatureEnabled("campaigns"), requireSalonPermission("campaigns", "view"), async (req, res) => {
    const row = await prisma.campaign.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
    if (!row) return res.status(404).json({ message: "Campaign not found" });
    const q = String(req.query.q || "").trim();
    const eventType = String(req.query.eventType || "").trim();
    const logs = await prisma.campaignLog.findMany({
      where: {
        campaignId: row.id,
        ...(eventType ? { eventType } : {}),
        ...(q ? { details: { contains: q, mode: "insensitive" } } : {})
      },
      orderBy: { createdAt: "desc" }
    });
    const csv = buildCsv(
      ["Campaign", "Event Type", "Details", "Created At"],
      logs.map((log) => [row.name, log.eventType, log.details || "", log.createdAt ? new Date(log.createdAt).toISOString() : ""])
    );
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename=\"campaign-${row.id}-logs.csv\"`);
    res.send(csv);
  });
};
