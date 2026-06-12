import { prisma } from "../../../lib/prisma.js";
import { buildWhatsAppLink, renderTemplateText, resolveTemplateContext } from "../../../lib/phase3.js";
import { defaultMessageTemplates, ensureMessageTemplate, normalizeTemplateType } from "../../../lib/messageTemplates.js";
import { requireFeatureEnabled, requireSalonPermission } from "../../../middlewares/rbac.js";
import { schemas, validate } from "../../../middlewares/validate.js";

export const registerMessageTemplateRoutes = (ownerRouter) => {
  ownerRouter.get("/message-templates", requireFeatureEnabled("messageTemplates"), requireSalonPermission("messageTemplates", "view"), async (req, res) => {
    const rows = await Promise.all(Object.keys(defaultMessageTemplates).map((type) => ensureMessageTemplate(req.salonId, type)));
    res.json(rows);
  });
  ownerRouter.get("/message-templates/:type", requireFeatureEnabled("messageTemplates"), requireSalonPermission("messageTemplates", "view"), async (req, res) => {
    res.json(await ensureMessageTemplate(req.salonId, req.params.type));
  });
  ownerRouter.patch("/message-templates/:type", requireFeatureEnabled("messageTemplates"), requireSalonPermission("messageTemplates", "edit"), validate(schemas.messageTemplate), async (req, res) => {
    const row = await ensureMessageTemplate(req.salonId, req.params.type);
    res.json(await prisma.messageTemplate.update({
      where: { id: row.id },
      data: {
        title: req.body.title,
        content: req.body.content,
        variables: req.body.variables || row.variables || []
      }
    }));
  });
  ownerRouter.post("/message-templates/:type/preview", requireFeatureEnabled("messageTemplates"), requireSalonPermission("messageTemplates", "view"), validate(schemas.messageTemplatePreview), async (req, res) => {
    const row = await ensureMessageTemplate(req.salonId, req.params.type);
    const variables = await resolveTemplateContext(req.salonId, req.body);
    const content = renderTemplateText(row.content, variables);
    const whatsappLink = buildWhatsAppLink(req.body.phone || variables.customer_phone || "", content);
    res.json({
      template: row,
      variables,
      preview: content,
      whatsappLink
    });
  });
  ownerRouter.post("/message-templates/:type/reset", requireFeatureEnabled("messageTemplates"), requireSalonPermission("messageTemplates", "edit"), async (req, res) => {
    const normalizedType = normalizeTemplateType(req.params.type);
    const fallback = defaultMessageTemplates[normalizedType];
    if (!fallback) return res.status(404).json({ message: "Template type not found" });
    const row = await ensureMessageTemplate(req.salonId, normalizedType);
    res.json(await prisma.messageTemplate.update({
      where: { id: row.id },
      data: { title: fallback.title, content: fallback.content, variables: fallback.variables || [] }
    }));
  });
};
