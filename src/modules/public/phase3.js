import { createOnlineOrder, createPublicAppointment, ensurePublicStoreEnabled, getPublicCatalogData, resolvePublicSalonBySlug, trackCatalogEvent, validateCartAgainstStock } from "../../lib/phase3.js";
import { attemptCustomerTemplateEmail } from "../../lib/emailNotifications.js";
import { asyncHandler } from "../../lib/async-handler.js";
import { schemas, validate } from "../../middlewares/validate.js";

export const registerPublicPhase3Routes = (publicRouter) => {
  publicRouter.get("/salons/:slug", asyncHandler(async (req, res) => {
    res.json(await getPublicCatalogData(req.params.slug));
  }));
  publicRouter.get("/salons/:slug/services", asyncHandler(async (req, res) => {
    const data = await getPublicCatalogData(req.params.slug);
    res.json({ salon: data.salon, settings: data.settings, services: data.services });
  }));
  publicRouter.get("/salons/:slug/packages", asyncHandler(async (req, res) => {
    const data = await getPublicCatalogData(req.params.slug);
    res.json({ salon: data.salon, settings: data.settings, packages: data.packages });
  }));
  publicRouter.get("/salons/:slug/memberships", asyncHandler(async (req, res) => {
    const data = await getPublicCatalogData(req.params.slug);
    res.json({ salon: data.salon, settings: data.settings, memberships: data.memberships });
  }));
  publicRouter.get("/salons/:slug/products", asyncHandler(async (req, res) => {
    const data = await getPublicCatalogData(req.params.slug);
    res.json({ salon: data.salon, settings: data.settings, products: data.products });
  }));
  publicRouter.get("/salons/:slug/offers", asyncHandler(async (req, res) => {
    const data = await getPublicCatalogData(req.params.slug);
    res.json({ salon: data.salon, settings: data.settings, offers: data.offers });
  }));
  publicRouter.post("/salons/:slug/analytics/event", validate(schemas.catalogEvent), asyncHandler(async (req, res) => {
    const event = await trackCatalogEvent({ slug: req.params.slug, body: req.body });
    res.status(201).json({ ok: true, eventId: event?.id || null });
  }));
  publicRouter.post("/salons/:slug/book", validate(schemas.publicBooking), asyncHandler(async (req, res) => {
    const appointment = await createPublicAppointment({ slug: req.params.slug, body: req.body });
    await attemptCustomerTemplateEmail({
      salonId: appointment.salonId,
      toEmail: appointment.customer?.email || "",
      templateType: "appointment_confirmation",
      context: {
        appointmentId: appointment.id,
        customerId: appointment.customerId
      }
    });
    res.status(201).json(appointment);
  }));
  publicRouter.post("/salons/:slug/cart/validate", validate(schemas.cartValidate), asyncHandler(async (req, res) => {
    const { salon } = await resolvePublicSalonBySlug(req.params.slug);
    await ensurePublicStoreEnabled(salon.id);
    const products = await validateCartAgainstStock(salon.id, req.body.items);
    res.json({ ok: true, products });
  }));
  publicRouter.post("/salons/:slug/orders", validate(schemas.createOrder), asyncHandler(async (req, res) => {
    const { salon } = await resolvePublicSalonBySlug(req.params.slug);
    await ensurePublicStoreEnabled(salon.id);
    const order = await createOnlineOrder({ salonId: salon.id, body: req.body, source: "PUBLIC_STORE" });
    await attemptCustomerTemplateEmail({
      salonId: salon.id,
      toEmail: order.customer?.email || "",
      templateType: "order_confirmation",
      context: {
        orderId: order.id,
        customerId: order.customerId
      }
    });
    res.status(201).json(order);
  }));
};
