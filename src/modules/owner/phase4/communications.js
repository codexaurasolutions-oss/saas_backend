import { prisma } from "../../../lib/prisma.js";
import { buildCsv } from "../../../lib/phase2.js";
import { buildWhatsAppLink, getCampaignAudience, renderTemplateText } from "../../../lib/phase3.js";
import { sendMail } from "../../../lib/mailer.js";
import { createAuditLog } from "../../../lib/phase4.js";
import { requireFeatureEnabled, requireSalonPermission } from "../../../middlewares/rbac.js";
import { schemas, validate } from "../../../middlewares/validate.js";

export const registerCommunicationRoutes = (ownerRouter) => {
  const normalizeChannel = (value) => String(value || "EMAIL").trim().toUpperCase();
  const buildEmailHtml = (message) => `<div style="font-family:Arial,sans-serif;white-space:pre-wrap;">${String(message || "")}</div>`;

  ownerRouter.get("/campaign-templates", requireFeatureEnabled("campaignTemplates"), requireSalonPermission("campaignTemplates", "view"), async (req, res) => {
    res.json(await prisma.campaignTemplate.findMany({ where: { salonId: req.salonId }, orderBy: { createdAt: "desc" } }));
  });
  ownerRouter.post("/campaign-templates", requireFeatureEnabled("campaignTemplates"), requireSalonPermission("campaignTemplates", "create"), validate(schemas.campaignTemplate), async (req, res) => {
    res.status(201).json(await prisma.campaignTemplate.create({
      data: {
        salonId: req.salonId,
        createdByMembershipId: req.user.membershipId || null,
        name: req.body.name,
        title: req.body.title,
        tier: req.body.tier || "FREE",
        category: req.body.category || null,
        backgroundColor: req.body.backgroundColor || null,
        textColor: req.body.textColor || null,
        offerText: req.body.offerText || null,
        logoUrl: req.body.logoUrl || null,
        imageUrl: req.body.imageUrl || null,
        layoutJson: req.body.layoutJson || null,
        isActive: req.body.isActive ?? true
      }
    }));
  });
  ownerRouter.patch("/campaign-templates/:id", requireFeatureEnabled("campaignTemplates"), requireSalonPermission("campaignTemplates", "edit"), validate(schemas.campaignTemplate), async (req, res) => {
    const row = await prisma.campaignTemplate.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
    if (!row) return res.status(404).json({ message: "Campaign template not found" });
    res.json(await prisma.campaignTemplate.update({
      where: { id: row.id },
      data: {
        name: req.body.name,
        title: req.body.title,
        tier: req.body.tier || "FREE",
        category: req.body.category || null,
        backgroundColor: req.body.backgroundColor || null,
        textColor: req.body.textColor || null,
        offerText: req.body.offerText || null,
        logoUrl: req.body.logoUrl || null,
        imageUrl: req.body.imageUrl || null,
        layoutJson: req.body.layoutJson || null,
        isActive: req.body.isActive ?? true
      }
    }));
  });

  ownerRouter.get("/campaigns/:id/performance", requireFeatureEnabled("campaignAnalytics"), requireSalonPermission("campaignAnalytics", "view"), async (req, res) => {
    const campaign = await prisma.campaign.findFirst({ where: { id: req.params.id, salonId: req.salonId }, include: { logs: true, conversions: true } });
    if (!campaign) return res.status(404).json({ message: "Campaign not found" });
    res.json({
      campaign,
      sentCount: campaign.logs.filter((row) => row.eventType.includes("SENT")).length,
      conversionCount: campaign.conversions.length
    });
  });
  ownerRouter.get("/campaigns/:id/conversions", requireFeatureEnabled("campaignAnalytics"), requireSalonPermission("campaignAnalytics", "view"), async (req, res) => {
    const rows = await prisma.campaignConversion.findMany({ where: { salonId: req.salonId, campaignId: req.params.id }, include: { customer: true, invoice: true, order: true }, orderBy: { createdAt: "desc" } });
    res.json(rows);
  });
  ownerRouter.get("/campaigns/:id/roi", requireFeatureEnabled("campaignAnalytics"), requireSalonPermission("campaignAnalytics", "view"), async (req, res) => {
    const rows = await prisma.campaignConversion.findMany({ where: { salonId: req.salonId, campaignId: req.params.id } });
    const revenue = rows.reduce((sum, row) => sum + Number(row.revenueAmount || 0), 0);
    res.json({ campaignId: req.params.id, revenue, conversions: rows.length, roi: revenue });
  });
  ownerRouter.get("/campaigns/:id/audience", requireFeatureEnabled("campaignAnalytics"), requireSalonPermission("campaignAnalytics", "view"), async (req, res) => {
    const campaign = await prisma.campaign.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
    if (!campaign) return res.status(404).json({ message: "Campaign not found" });
    const audience = await getCampaignAudience(req.salonId, campaign.audienceFilter, campaign.audienceMeta || {});
    res.json({ total: audience.length, rows: audience.slice(0, 100) });
  });
  ownerRouter.post("/campaigns/:id/link-coupon", requireFeatureEnabled("campaigns"), requireSalonPermission("campaigns", "edit"), validate(schemas.linkCoupon), async (req, res) => {
    const campaign = await prisma.campaign.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
    if (!campaign) return res.status(404).json({ message: "Campaign not found" });
    res.json(await prisma.campaign.update({ where: { id: campaign.id }, data: { linkedCouponId: req.body.couponId } }));
  });
  ownerRouter.post("/campaigns/:id/upload-to-catalog", requireFeatureEnabled("campaigns"), requireSalonPermission("campaigns", "edit"), async (req, res) => {
    const campaign = await prisma.campaign.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
    if (!campaign) return res.status(404).json({ message: "Campaign not found" });
    const banner = await prisma.catalogBanner.create({
      data: {
        salonId: req.salonId,
        title: campaign.name,
        subtitle: campaign.message || null,
        imageUrl: campaign.bannerUrl || null,
        linkUrl: campaign.linkedBannerId || null
      }
    });
    res.status(201).json(banner);
  });

  ownerRouter.get("/whatsapp/settings", requireFeatureEnabled("whatsapp"), requireSalonPermission("whatsapp", "view"), async (req, res) => {
    res.json(await prisma.whatsAppSetting.findFirst({ where: { salonId: req.salonId } }));
  });
  ownerRouter.post("/whatsapp/settings", requireFeatureEnabled("whatsapp"), requireSalonPermission("whatsapp", "edit"), validate(schemas.whatsappSettings), async (req, res) => {
    const existing = await prisma.whatsAppSetting.findFirst({ where: { salonId: req.salonId } });
    const data = {
      providerName: req.body.providerName || null,
      senderName: req.body.senderName || null,
      apiUrl: req.body.apiUrl || null,
      apiKeyPlaceholder: req.body.apiKeyPlaceholder || null,
      automationEnabled: req.body.automationEnabled ?? false,
      deliveryStatusEnabled: req.body.deliveryStatusEnabled ?? false,
      readStatusEnabled: req.body.readStatusEnabled ?? false
    };
    res.json(existing
      ? await prisma.whatsAppSetting.update({ where: { id: existing.id }, data })
      : await prisma.whatsAppSetting.create({ data: { salonId: req.salonId, ...data } }));
  });

  ownerRouter.get("/whatsapp/logs", requireFeatureEnabled("whatsapp"), requireSalonPermission("whatsapp", "view"), async (req, res) => {
    const q = String(req.query.q || "").trim();
    const status = String(req.query.status || "").trim();
    const templateType = String(req.query.templateType || "").trim();
    res.json(await prisma.whatsAppLog.findMany({
      where: {
        salonId: req.salonId,
        ...(status ? { status } : {}),
        ...(templateType ? { templateType } : {}),
        ...(q ? {
          OR: [
            { phone: { contains: q } },
            { templateType: { contains: q } },
            { message: { contains: q } },
            { customer: { is: { name: { contains: q } } } },
            { campaign: { is: { name: { contains: q } } } }
          ]
        } : {})
      },
      include: { customer: true, campaign: true },
      orderBy: { createdAt: "desc" }
    }));
  });
  ownerRouter.patch("/whatsapp/logs/:id/status", requireFeatureEnabled("whatsapp"), requireSalonPermission("whatsapp", "edit"), validate(schemas.whatsappLogStatus), async (req, res) => {
    const row = await prisma.whatsAppLog.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
    if (!row) return res.status(404).json({ message: "WhatsApp log not found" });
    const updated = await prisma.whatsAppLog.update({
      where: { id: row.id },
      data: {
        status: req.body.status,
        metadata: {
          ...(row.metadata && typeof row.metadata === "object" ? row.metadata : {}),
          placeholderStatusUpdatedAt: new Date().toISOString()
        }
      },
      include: { customer: true, campaign: true }
    });
    await createAuditLog({
      salonId: req.salonId,
      actorUserId: req.user.userId,
      actorMembershipId: req.user.membershipId,
      module: "WHATSAPP",
      action: "LOG_STATUS_UPDATED",
      entityType: "WhatsAppLog",
      entityId: row.id,
      summary: `WhatsApp log marked ${req.body.status}`
    });
    res.json(updated);
  });
  ownerRouter.patch("/whatsapp/logs/:id/reply-placeholder", requireFeatureEnabled("whatsapp"), requireSalonPermission("whatsapp", "edit"), validate(schemas.whatsappReplyPlaceholder), async (req, res) => {
    const row = await prisma.whatsAppLog.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
    if (!row) return res.status(404).json({ message: "WhatsApp log not found" });
    const updated = await prisma.whatsAppLog.update({
      where: { id: row.id },
      data: {
        status: "OPEN_PLACEHOLDER",
        metadata: {
          ...(row.metadata && typeof row.metadata === "object" ? row.metadata : {}),
          lastReplyNote: req.body.replyNote,
          lastReplyAt: new Date().toISOString(),
          lastReplyBy: req.user.name || "Team"
        }
      },
      include: { customer: true, campaign: true }
    });
    await createAuditLog({
      salonId: req.salonId,
      actorUserId: req.user.userId,
      actorMembershipId: req.user.membershipId,
      module: "WHATSAPP",
      action: "REPLY_PLACEHOLDER_LOGGED",
      entityType: "WhatsAppLog",
      entityId: row.id,
      summary: "WhatsApp reply placeholder logged"
    });
    res.json(updated);
  });
  ownerRouter.get("/whatsapp/logs/export.csv", requireFeatureEnabled("whatsapp"), requireSalonPermission("whatsapp", "view"), async (req, res) => {
    const q = String(req.query.q || "").trim();
    const status = String(req.query.status || "").trim();
    const templateType = String(req.query.templateType || "").trim();
    const rows = await prisma.whatsAppLog.findMany({
      where: {
        salonId: req.salonId,
        ...(status ? { status } : {}),
        ...(templateType ? { templateType } : {}),
        ...(q ? {
          OR: [
            { phone: { contains: q } },
            { templateType: { contains: q } },
            { message: { contains: q } },
            { customer: { is: { name: { contains: q } } } },
            { campaign: { is: { name: { contains: q } } } }
          ]
        } : {})
      },
      include: { customer: true, campaign: true },
      orderBy: { createdAt: "desc" }
    });
    const csv = buildCsv(
      ["Phone", "Template Type", "Status", "Customer", "Campaign", "Created At"],
      rows.map((row) => [row.phone, row.templateType || "", row.status, row.customer?.name || "", row.campaign?.name || "", row.createdAt ? new Date(row.createdAt).toISOString() : ""])
    );
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=\"whatsapp-logs-export.csv\"");
    res.send(csv);
  });
  ownerRouter.post("/whatsapp/send-manual", requireFeatureEnabled("whatsapp"), requireSalonPermission("whatsapp", "create"), validate(schemas.whatsappSend), async (req, res) => {
    const channel = normalizeChannel(req.body.channel);
    const recipient = channel === "EMAIL" ? String(req.body.email || "").trim() : String(req.body.phone || "").trim();

    if (channel === "EMAIL") {
      await sendMail({
        to: recipient,
        subject: req.body.templateType || "Salon Update",
        html: buildEmailHtml(req.body.message),
        text: req.body.message
      });
    }

    const row = await prisma.whatsAppLog.create({
      data: {
        salonId: req.salonId,
        customerId: req.body.customerId || null,
        actorMembershipId: req.user.membershipId || null,
        campaignId: req.body.campaignId || null,
        phone: recipient,
        templateType: req.body.templateType || null,
        message: req.body.message,
        status: "SENT",
        linkUrl: channel === "EMAIL" ? null : buildWhatsAppLink(recipient, req.body.message),
        metadata: {
          channel,
          addressType: channel === "EMAIL" ? "EMAIL" : "PHONE",
          ...(req.body.mediaUrl || req.body.mediaKind ? {
            mediaKind: req.body.mediaKind || null,
            mediaUrl: req.body.mediaUrl || null
          } : {})
        }
      }
    });
    await createAuditLog({
      salonId: req.salonId,
      actorUserId: req.user.userId,
      actorMembershipId: req.user.membershipId,
      module: "WHATSAPP",
      action: channel === "EMAIL" ? "MANUAL_EMAIL_SEND" : "MANUAL_SEND",
      entityType: "WhatsAppLog",
      entityId: row.id,
      summary: `${channel === "EMAIL" ? "Manual email" : "Manual WhatsApp message"} sent to ${recipient}`
    });
    res.status(201).json(row);
  });
  ownerRouter.post("/whatsapp/send-bulk-placeholder", requireFeatureEnabled("whatsapp"), requireSalonPermission("whatsapp", "create"), async (req, res) => {
    const channel = normalizeChannel(req.body.channel);
    const audience = await getCampaignAudience(req.salonId, req.body.audienceFilter || "ALL_CUSTOMERS", req.body.audienceMeta || {});
    const eligibleAudience = audience
      .filter((customer) => (channel === "EMAIL" ? customer.email : customer.phone))
      .slice(0, 50);

    if (channel === "EMAIL") {
      await Promise.allSettled(
        eligibleAudience.map((customer) =>
          sendMail({
            to: customer.email,
            subject: req.body.templateType || "Salon Update",
            html: buildEmailHtml(req.body.message || "Bulk email placeholder"),
            text: req.body.message || "Bulk email placeholder"
          })
        )
      );
    }

    const rows = eligibleAudience.map((customer) => ({
      salonId: req.salonId,
      customerId: customer.id,
      actorMembershipId: req.user.membershipId || null,
      phone: channel === "EMAIL" ? customer.email : customer.phone,
      templateType: req.body.templateType || "bulk_placeholder",
      message: req.body.message || (channel === "EMAIL" ? "Bulk email placeholder" : "Bulk WhatsApp placeholder"),
      status: "SENT",
      linkUrl: channel === "EMAIL" ? null : buildWhatsAppLink(customer.phone, req.body.message || "Bulk WhatsApp placeholder"),
      metadata: {
        channel,
        addressType: channel === "EMAIL" ? "EMAIL" : "PHONE",
        mediaKind: req.body.mediaKind || null,
        mediaUrl: req.body.mediaUrl || null
      }
    }));
    if (rows.length) await prisma.whatsAppLog.createMany({ data: rows });
    res.json({ sentCount: rows.length });
  });
  ownerRouter.get("/whatsapp/automations", requireFeatureEnabled("whatsapp"), requireSalonPermission("whatsapp", "view"), async (req, res) => {
    res.json(await prisma.whatsAppAutomation.findMany({ where: { salonId: req.salonId }, orderBy: { createdAt: "desc" } }));
  });
  ownerRouter.post("/whatsapp/automations", requireFeatureEnabled("whatsapp"), requireSalonPermission("whatsapp", "edit"), validate(schemas.whatsappAutomation), async (req, res) => {
    res.status(201).json(await prisma.whatsAppAutomation.create({
      data: {
        salonId: req.salonId,
        updatedByMembershipId: req.user.membershipId || null,
        eventKey: req.body.eventKey,
        templateType: req.body.templateType,
        audienceFilter: req.body.audienceFilter || null,
        mediaKind: req.body.mediaKind || null,
        mediaUrl: req.body.mediaUrl || null,
        isEnabled: req.body.isEnabled ?? true,
        notes: req.body.notes || null
      }
    }));
  });
  ownerRouter.patch("/whatsapp/automations/:id", requireFeatureEnabled("whatsapp"), requireSalonPermission("whatsapp", "edit"), validate(schemas.whatsappAutomation), async (req, res) => {
    const row = await prisma.whatsAppAutomation.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
    if (!row) return res.status(404).json({ message: "WhatsApp automation not found" });
    res.json(await prisma.whatsAppAutomation.update({
      where: { id: row.id },
      data: {
        updatedByMembershipId: req.user.membershipId || null,
        eventKey: req.body.eventKey,
        templateType: req.body.templateType,
        audienceFilter: req.body.audienceFilter || null,
        mediaKind: req.body.mediaKind || null,
        mediaUrl: req.body.mediaUrl || null,
        isEnabled: req.body.isEnabled ?? true,
        notes: req.body.notes || null
      }
    }));
  });
};
