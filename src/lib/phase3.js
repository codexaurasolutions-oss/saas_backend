import { prisma } from "./prisma.js";
import { checkStaffAvailability, createStockMovement, ensureScopedBranch, ensureScopedCustomer, ensureScopedService, ensureScopedStaffMembership, logCustomerTimeline, normalizeBranchId, refreshCustomerInsights, toAmount } from "./phase2.js";
import { createInvoiceNumber } from "./pos.js";

const publicFeatureEnabled = (flags = {}, key) => flags?.[key] !== false;

export const defaultCatalogTheme = "#0f766e";

export const buildCatalogLink = (slug) => `${process.env.FRONTEND_APP_URL || "http://127.0.0.1:5173"}/salon/${slug}`;

export const normalizeBeforeAfterGallery = (value) => {
  if (!Array.isArray(value)) return [];
  return value
    .map((item, index) => ({
      id: String(item?.id || `gallery-${index + 1}`),
      title: String(item?.title || item?.serviceName || `Result ${index + 1}`),
      subtitle: item?.subtitle ? String(item.subtitle) : "",
      beforeImageUrl: item?.beforeImageUrl ? String(item.beforeImageUrl) : "",
      afterImageUrl: item?.afterImageUrl ? String(item.afterImageUrl) : "",
      serviceName: item?.serviceName ? String(item.serviceName) : "",
      resultNote: item?.resultNote ? String(item.resultNote) : ""
    }))
    .filter((item) => item.beforeImageUrl || item.afterImageUrl);
};

export const buildWhatsAppLink = (phone, message) => {
  if (!phone) return null;
  const normalized = String(phone).replace(/[^\d+]/g, "");
  return `https://wa.me/${encodeURIComponent(normalized)}?text=${encodeURIComponent(message || "")}`;
};

export const ensurePublicBookingEnabled = async (salonId, branchId = null) => {
  const [salon, branchSetting, globalSetting, anySetting] = await Promise.all([
    prisma.salon.findUnique({
      where: { id: salonId },
      select: { featureFlags: true, status: true }
    }),
    branchId
      ? prisma.appointmentSetting.findFirst({ where: { salonId, branchId } })
      : Promise.resolve(null),
    prisma.appointmentSetting.findFirst({ where: { salonId, branchId: null } }),
    prisma.appointmentSetting.findFirst({ where: { salonId } })
  ]);

  if (!salon || ["SUSPENDED", "EXPIRED"].includes(salon.status)) {
    const error = new Error("Online booking is unavailable for this salon");
    error.status = 403;
    throw error;
  }
  if (publicFeatureEnabled(salon.featureFlags, "appointments") === false) {
    const error = new Error("Online booking is disabled for this salon");
    error.status = 403;
    throw error;
  }

  const effectiveSetting = branchSetting || globalSetting;
  const onlineBookingEnabled = effectiveSetting
    ? effectiveSetting.onlineBookingEnabled !== false
    : !anySetting || anySetting.onlineBookingEnabled !== false;
  if (!onlineBookingEnabled) {
    const error = new Error("Online booking is disabled for this salon");
    error.status = 403;
    throw error;
  }

  return effectiveSetting || anySetting || { onlineBookingEnabled: true };
};

export const ensurePublicStoreEnabled = async (salonId) => {
  const [salon, ecommerceSettings] = await Promise.all([
    prisma.salon.findUnique({
      where: { id: salonId },
      select: { featureFlags: true, status: true }
    }),
    prisma.ecommerceSetting.findUnique({ where: { salonId } })
  ]);

  if (!salon || ["SUSPENDED", "EXPIRED"].includes(salon.status)) {
    const error = new Error("E-commerce store is unavailable for this salon");
    error.status = 403;
    throw error;
  }
  if (publicFeatureEnabled(salon.featureFlags, "ecommerce") === false) {
    const error = new Error("E-commerce store is disabled for this salon");
    error.status = 403;
    throw error;
  }
  if (!ecommerceSettings?.storeEnabled) {
    const error = new Error("E-commerce store is disabled for this salon");
    error.status = 403;
    throw error;
  }

  return ecommerceSettings;
};

export const resolvePublicSalonBySlug = async (slug) => {
  const directSalon = await prisma.salon.findUnique({
    where: { slug },
    select: { id: true }
  });
  const customSlugSetting = directSalon
    ? null
    : await prisma.catalogSetting.findFirst({
        where: { customSlug: slug },
        select: { salonId: true }
      });
  const salonId = directSalon?.id || customSlugSetting?.salonId || null;
  const salon = salonId
    ? await prisma.salon.findUnique({
        where: { id: salonId },
        include: {
          branches: { where: { isActive: true }, orderBy: { createdAt: "asc" } },
          catalogSettings: true,
          ecommerceSettings: true
        }
      })
    : null;
  if (!salon) {
    const error = new Error("Salon not found");
    error.status = 404;
    throw error;
  }

  const catalogSettings = salon.catalogSettings.find((item) => item.branchId === null) || salon.catalogSettings[0] || null;
  const featureFlags = salon.featureFlags || {};
  const catalogAllowed = publicFeatureEnabled(featureFlags, "publicCatalog") && publicFeatureEnabled(featureFlags, "digitalCatalog");
  if (!catalogAllowed || catalogSettings?.catalogEnabled === false) {
    const error = new Error("Public catalog is disabled for this salon");
    error.status = 403;
    throw error;
  }
  if (["SUSPENDED", "EXPIRED"].includes(salon.status) && !catalogSettings?.allowSuspendedCatalog) {
    const error = new Error("Public catalog is unavailable for this salon");
    error.status = 403;
    throw error;
  }

  return { salon, catalogSettings, ecommerceSettings: salon.ecommerceSettings[0] || null };
};

export const getPublicCatalogData = async (slug) => {
  const { salon, catalogSettings, ecommerceSettings } = await resolvePublicSalonBySlug(slug);
  const appointmentSettings = await prisma.appointmentSetting.findMany({
    where: { salonId: salon.id },
    orderBy: [{ branchId: "asc" }]
  });
  const visibility = {
    services: catalogSettings?.showServices !== false,
    packages: catalogSettings?.showPackages !== false,
    memberships: catalogSettings?.showMemberships !== false,
    products: catalogSettings?.showProducts !== false && publicFeatureEnabled(salon.featureFlags, "ecommerce") !== false && ecommerceSettings?.storeEnabled === true,
    staff: catalogSettings?.showStaffPortfolio !== false
  };

  const [services, packages, memberships, products, offers, staff, banners] = await Promise.all([
    visibility.services
      ? prisma.service.findMany({ where: { salonId: salon.id, isActive: true, isPublicVisible: true }, include: { branch: true }, orderBy: { createdAt: "desc" } })
      : [],
    visibility.packages
      ? prisma.package.findMany({ where: { salonId: salon.id, isActive: true, isPublicVisible: true }, include: { services: { include: { service: true } } }, orderBy: { createdAt: "desc" } })
      : [],
    visibility.memberships
      ? prisma.membershipPlan.findMany({ where: { salonId: salon.id, isActive: true, isPublicVisible: true }, include: { services: { include: { service: true } } }, orderBy: { createdAt: "desc" } })
      : [],
    visibility.products
      ? prisma.product.findMany({ where: { salonId: salon.id, isActive: true, isOnlineVisible: true }, include: { category: true, branch: true }, orderBy: { createdAt: "desc" } })
      : [],
    prisma.catalogOffer.findMany({
      where: {
        salonId: salon.id,
        isActive: true,
        OR: [{ startsAt: null }, { startsAt: { lte: new Date() } }],
        AND: [{ OR: [{ endsAt: null }, { endsAt: { gte: new Date() } }] }]
      },
      orderBy: { createdAt: "desc" }
    }),
    visibility.staff
      ? prisma.userSalon.findMany({
          where: { salonId: salon.id, showInCatalog: true, isArchived: false, user: { isActive: true } },
          include: { user: true, branch: true, serviceAssignments: { include: { service: true } } },
          orderBy: { id: "desc" }
        })
      : [],
    prisma.catalogBanner.findMany({ where: { salonId: salon.id, isActive: true }, orderBy: [{ sortOrder: "asc" }, { createdAt: "desc" }] })
  ]);

  return {
    salon,
    settings: {
      ...catalogSettings,
      beforeAfterGallery: normalizeBeforeAfterGallery(catalogSettings?.beforeAfterGallery)
    },
    ecommerceSettings,
    services,
    packages,
    memberships,
    products,
    offers,
    staff,
    banners,
    publicLink: buildCatalogLink(catalogSettings?.customSlug || salon.slug),
    bookingEnabled: Boolean(
      publicFeatureEnabled(salon.featureFlags, "appointments") !== false &&
      (
        !appointmentSettings.length ||
        appointmentSettings.some((item) => item.onlineBookingEnabled !== false)
      )
    ),
    storeEnabled: Boolean(publicFeatureEnabled(salon.featureFlags, "ecommerce") !== false && ecommerceSettings?.storeEnabled)
  };
};

export const trackCatalogEvent = async ({ slug, body }) => {
  try {
    const { salon } = await resolvePublicSalonBySlug(slug);
    return await prisma.catalogAnalyticsEvent.create({
      data: {
        salonId: salon.id,
        branchId: body.branchId || null,
        eventType: body.eventType,
        slug,
        serviceId: body.serviceId || null,
        productId: body.productId || null,
        offerId: body.offerId || null,
        metadata: body.metadata || null
      }
    });
  } catch {
    return null;
  }
};

export const createPublicAppointment = async ({ slug, body }) => {
  const { salon } = await resolvePublicSalonBySlug(slug);
  await ensureScopedBranch(salon.id, body.branchId);
  await ensurePublicBookingEnabled(salon.id, body.branchId);

  let customer = await prisma.customer.findFirst({
    where: {
      salonId: salon.id,
      OR: [
        { phone: body.customerPhone },
        ...(body.customerEmail ? [{ email: body.customerEmail }] : [])
      ]
    }
  });

  const created = await prisma.$transaction(async (tx) => {
    if (!customer) {
      customer = await tx.customer.create({
        data: {
          salonId: salon.id,
          name: body.customerName,
          phone: body.customerPhone,
          email: body.customerEmail || null,
          notes: "Created from public booking"
        }
      });
    }

    const branchId = body.branchId;
    const assignedStaffIds = new Set();
    for (const item of body.items) {
      await ensureScopedService(salon.id, item.serviceId);
      for (const staffId of item.staffUserIds) {
        await ensureScopedStaffMembership(salon.id, staffId);
        assignedStaffIds.add(staffId);
      }
      await checkStaffAvailability({
        salonId: salon.id,
        branchId,
        staffMembershipIds: item.staffUserIds,
        startAt: item.startAt,
        endAt: item.endAt
      });
    }

    const appointment = await tx.appointment.create({
      data: {
        salonId: salon.id,
        branchId,
        customerId: customer.id,
        primaryStaffUserId: body.primaryStaffUserId || [...assignedStaffIds][0] || null,
        title: body.title || "Online Booking",
        bookingChannel: "ONLINE_PLACEHOLDER",
        status: "PENDING",
        startAt: new Date(body.startAt),
        endAt: new Date(body.endAt),
        notes: body.notes || null,
        customerPreferences: body.customerPreferences || null,
        approvalStatus: "APPROVED",
        isWalkIn: false,
        items: {
          create: body.items.map((item) => ({
            serviceId: item.serviceId,
            startAt: new Date(item.startAt),
            endAt: new Date(item.endAt),
            notes: item.notes || null,
            assignedStaff: {
              create: item.staffUserIds.map((staffId) => ({ userSalonId: staffId }))
            }
          }))
        }
      },
      include: {
        customer: true,
        branch: true,
        items: { include: { service: true, assignedStaff: { include: { userSalon: { include: { user: true } } } } } }
      }
    });

    await tx.appointmentLog.create({
      data: {
        appointmentId: appointment.id,
        action: "PUBLIC_BOOKING_CREATED",
        details: "Booking started from digital catalog"
      }
    });
    await logCustomerTimeline(tx, customer.id, "APPOINTMENT", "Public booking created", appointment.title || "Online Booking", appointment.id);
    await tx.customerNotification.create({
      data: {
        salonId: salon.id,
        customerId: customer.id,
        title: "Booking request created",
        message: `Your appointment for ${new Date(body.startAt).toLocaleString()} has been created.`,
        linkUrl: `/customer/appointments/${appointment.id}`
      }
    });

    return appointment;
  });

  return created;
};

export const validateCartAgainstStock = async (salonId, items) => {
  const products = await prisma.product.findMany({
    where: { salonId, id: { in: items.map((item) => item.productId) }, isActive: true, isOnlineVisible: true }
  });
  const productMap = new Map(products.map((product) => [product.id, product]));
  for (const item of items) {
    const product = productMap.get(item.productId);
    if (!product) {
      const error = new Error("One or more products are unavailable");
      error.status = 400;
      throw error;
    }
    if (toAmount(product.currentStock) < Number(item.qty)) {
      const error = new Error(`Out of stock: ${product.name}`);
      error.status = 400;
      throw error;
    }
  }
  return products;
};

export const createOnlineOrder = async ({ salonId, body, actorName = "PUBLIC_STORE", source = "PUBLIC_STORE" }) => {
  const branchId = normalizeBranchId(body.branchId);
  if (branchId) await ensureScopedBranch(salonId, branchId);
  const products = await validateCartAgainstStock(salonId, body.items);
  const productMap = new Map(products.map((product) => [product.id, product]));

  return prisma.$transaction(async (tx) => {
    let customer = null;
    if (body.customerId) {
      customer = await ensureScopedCustomer(salonId, body.customerId);
    } else {
      customer = await tx.customer.findFirst({
        where: {
          salonId,
          OR: [
            { phone: body.customerPhone },
            ...(body.customerEmail ? [{ email: body.customerEmail }] : [])
          ]
        }
      });
      if (!customer) {
        customer = await tx.customer.create({
          data: {
            salonId,
            name: body.customerName,
            phone: body.customerPhone,
            email: body.customerEmail || null,
            source: "ONLINE_STORE"
          }
        });
      }
    }

    const count = await tx.onlineOrder.count({ where: { salonId } });
    const orderNumber = `ORD-${String(count + 1).padStart(5, "0")}`;
    const subtotal = body.items.reduce((sum, item) => {
      const product = productMap.get(item.productId);
      return sum + toAmount(product.sellingPrice) * Number(item.qty);
    }, 0);
    const total = subtotal;

    const order = await tx.onlineOrder.create({
      data: {
        salonId,
        customerId: customer.id,
        branchId,
        orderNumber,
        customerName: customer.name,
        customerPhone: customer.phone,
        customerEmail: customer.email || null,
        note: body.note || null,
        paymentStatus: body.paymentMode === "ONLINE_PLACEHOLDER" ? "PENDING" : "PENDING",
        fulfillmentMethod: body.fulfillmentMethod || "PICKUP",
        source,
        subtotal,
        total,
        couponCode: body.couponCode || null,
        giftCardCode: body.giftCardCode || null,
        stockDeductedAt: new Date(),
        items: {
          create: body.items.map((item) => {
            const product = productMap.get(item.productId);
            return {
              productId: product.id,
              productName: product.name,
              qty: Number(item.qty),
              unitPrice: toAmount(product.sellingPrice),
              lineTotal: toAmount(product.sellingPrice) * Number(item.qty)
            };
          })
        },
        logs: {
          create: {
            actorName,
            toStatus: "NEW",
            note: "Order created from online checkout"
          }
        }
      },
      include: {
        items: true,
        customer: true,
        branch: true
      }
    });

    for (const item of order.items) {
      await createStockMovement(tx, {
        salonId,
        branchId: branchId || productMap.get(item.productId)?.branchId || null,
        productId: item.productId,
        quantity: -Number(item.qty),
        movementType: "POS_SALE",
        referenceType: "ONLINE_ORDER",
        referenceId: order.id,
        note: `Online order ${order.orderNumber}`,
        allowNegativeStock: false
      });
    }

    await logCustomerTimeline(tx, customer.id, "ORDER", "Online order placed", order.orderNumber, order.id);
    await tx.customerNotification.create({
      data: {
        salonId,
        customerId: customer.id,
        title: "Order placed",
        message: `Your order ${order.orderNumber} was placed successfully.`,
        linkUrl: `/customer/orders/${order.id}`
      }
    });
    await refreshCustomerInsights(tx, customer.id);

    return tx.onlineOrder.findUnique({
      where: { id: order.id },
      include: {
        items: { include: { product: true } },
        logs: { orderBy: { createdAt: "asc" } },
        customer: true,
        branch: true
      }
    });
  });
};

export const reverseOrderStock = async (tx, order, actorName, note) => {
  const items = order.items || await tx.onlineOrderItem.findMany({ where: { orderId: order.id } });
  for (const item of items) {
    await createStockMovement(tx, {
      salonId: order.salonId,
      branchId: order.branchId || null,
      productId: item.productId,
      quantity: Number(item.qty),
      movementType: "PRODUCT_RETURN",
      referenceType: "ONLINE_ORDER_CANCEL",
      referenceId: order.id,
      note: note || `Order ${order.orderNumber} cancelled`,
      allowNegativeStock: true
    });
  }
  await tx.onlineOrderStatusLog.create({
    data: {
      orderId: order.id,
      actorName,
      fromStatus: order.status,
      toStatus: "CANCELLED",
      note: note || "Order cancelled"
    }
  });
};

export const convertOrderToInvoice = async ({ salonId, orderId, actorUser }) => {
  return prisma.$transaction(async (tx) => {
    const order = await tx.onlineOrder.findFirst({
      where: { id: orderId, salonId },
      include: { items: true, customer: true }
    });
    if (!order) {
      const error = new Error("Order not found");
      error.status = 404;
      throw error;
    }
    if (order.invoiceId) {
      return tx.invoice.findUnique({ where: { id: order.invoiceId }, include: { items: true, payments: true, customer: true, branch: true } });
    }

    const invoiceNumber = await createInvoiceNumber(tx, salonId, order.branchId || null);
    const invoice = await tx.invoice.create({
      data: {
        salonId,
        branchId: order.branchId || null,
        customerId: order.customerId,
        invoiceNumber,
        status: order.paymentStatus === "PAID" ? "PAID" : "UNPAID",
        subtotal: toAmount(order.subtotal),
        discount: toAmount(order.discount),
        tax: toAmount(order.tax),
        total: toAmount(order.total),
        paidAmount: toAmount(order.paidAmount),
        balanceAmount: Math.max(0, toAmount(order.total) - toAmount(order.paidAmount)),
        notes: `Converted from order ${order.orderNumber}`,
        items: {
          create: order.items.map((item) => ({
            serviceName: item.productName,
            qty: item.qty,
            unitPrice: toAmount(item.unitPrice),
            taxPct: 0,
            lineTotal: toAmount(item.lineTotal),
            itemType: "PRODUCT",
            ...(item.productId ? { product: { connect: { id: item.productId } } } : {})
          }))
        }
      }
    });

    await tx.onlineOrder.update({
      where: { id: order.id },
      data: { invoiceId: invoice.id }
    });
    await tx.onlineOrderStatusLog.create({
      data: {
        orderId: order.id,
        actorName: actorUser?.name || "SYSTEM",
        fromStatus: order.status,
        toStatus: order.status,
        note: `Converted to invoice ${invoice.invoiceNumber}`
      }
    });
    await logCustomerTimeline(tx, order.customerId, "INVOICE", "Order converted to invoice", invoice.invoiceNumber, invoice.id);

    return tx.invoice.findUnique({
      where: { id: invoice.id },
      include: { items: true, payments: true, customer: true, branch: true }
    });
  });
};

const templateFallbacks = {
  customer_name: "Customer",
  salon_name: "ReSpark Salon",
  appointment_date_time: "N/A",
  invoice_amount: "0.00",
  membership_expiry: "N/A",
  package_balance: "0",
  order_number: "N/A",
  order_amount: "0.00",
  catalog_link: "",
  payment_link: ""
};

export const renderTemplateText = (content, variables) =>
  String(content || "").replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_, key) => {
    const value = variables?.[key];
    return value == null || value === "" ? templateFallbacks[key] ?? "" : String(value);
  });

export const resolveTemplateContext = async (salonId, context = {}) => {
  const [salon, customer, appointment, invoice, order, membership, pack] = await Promise.all([
    prisma.salon.findUnique({ where: { id: salonId } }),
    context.customerId ? prisma.customer.findFirst({ where: { id: context.customerId, salonId } }) : null,
    context.appointmentId ? prisma.appointment.findFirst({ where: { id: context.appointmentId, salonId }, include: { customer: true } }) : null,
    context.invoiceId ? prisma.invoice.findFirst({ where: { id: context.invoiceId, salonId }, include: { customer: true } }) : null,
    context.orderId ? prisma.onlineOrder.findFirst({ where: { id: context.orderId, salonId }, include: { customer: true } }) : null,
    context.customerMembershipId ? prisma.customerMembership.findFirst({ where: { id: context.customerMembershipId, salonId }, include: { membershipPlan: true, customer: true } }) : null,
    context.customerPackageId ? prisma.customerPackage.findFirst({ where: { id: context.customerPackageId, salonId }, include: { package: true, customer: true } }) : null
  ]);

  const resolvedCustomer = customer || appointment?.customer || invoice?.customer || order?.customer || membership?.customer || pack?.customer || null;

  const resolved = {
    customer_name: resolvedCustomer?.name || templateFallbacks.customer_name,
    customer_phone: resolvedCustomer?.phone || "",
    salon_name: salon?.name || templateFallbacks.salon_name,
    appointment_date_time: appointment?.startAt ? new Date(appointment.startAt).toLocaleString() : templateFallbacks.appointment_date_time,
    invoice_amount: invoice ? Number(invoice.total || 0).toFixed(2) : templateFallbacks.invoice_amount,
    membership_expiry: membership?.endsAt ? new Date(membership.endsAt).toLocaleDateString() : templateFallbacks.membership_expiry,
    package_balance: pack?.remainingSessions != null ? String(pack.remainingSessions) : templateFallbacks.package_balance,
    order_number: order?.orderNumber || templateFallbacks.order_number,
    order_amount: order ? Number(order.total || 0).toFixed(2) : templateFallbacks.order_amount,
    catalog_link: salon ? buildCatalogLink(salon.slug) : templateFallbacks.catalog_link,
    payment_link: invoice?.paymentLinkToken ? `${process.env.FRONTEND_APP_URL || "http://127.0.0.1:5173"}/pay/${invoice.paymentLinkToken}` : templateFallbacks.payment_link
  };

  return {
    ...resolved,
    ...Object.fromEntries(
      Object.entries(context || {}).filter(([, value]) => value != null && value !== "")
    ),
    customerName: resolved.customer_name,
    customerPhone: resolved.customer_phone,
    salonName: resolved.salon_name,
    appointmentDateTime: resolved.appointment_date_time,
    invoiceAmount: resolved.invoice_amount,
    membershipExpiry: resolved.membership_expiry,
    packageBalance: resolved.package_balance,
    orderNumber: resolved.order_number,
    orderAmount: resolved.order_amount,
    catalogLink: resolved.catalog_link,
    paymentLink: resolved.payment_link
  };
};

export const getCampaignAudience = async (salonId, audienceFilter, audienceMeta = {}) => {
  const now = new Date();
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  const where = { salonId };

  if (audienceFilter === "BIRTHDAY_CUSTOMERS") {
    return prisma.customer.findMany({ where, orderBy: { createdAt: "desc" } }).then((rows) => rows.filter((row) => row.dateOfBirth && new Date(row.dateOfBirth).getMonth() === now.getMonth()));
  }
  if (audienceFilter === "ANNIVERSARY_CUSTOMERS") {
    return prisma.customer.findMany({ where, orderBy: { createdAt: "desc" } }).then((rows) => rows.filter((row) => row.anniversary && new Date(row.anniversary).getMonth() === now.getMonth()));
  }
  if (audienceFilter === "LOST_CUSTOMERS") {
    return prisma.customer.findMany({ where: { ...where, OR: [{ lastVisitAt: null }, { lastVisitAt: { lte: ninetyDaysAgo } }] } });
  }
  if (audienceFilter === "HIGH_SPENDERS") {
    return prisma.customer.findMany({ where: { ...where, totalSpend: { gte: 10000 } } });
  }
  if (audienceFilter === "MEMBERSHIP_CUSTOMERS") {
    return prisma.customer.findMany({ where: { ...where, memberships: { some: { status: "ACTIVE", endsAt: { gte: now } } } } });
  }
  if (audienceFilter === "PACKAGE_CUSTOMERS") {
    return prisma.customer.findMany({ where: { ...where, packages: { some: { status: "ACTIVE", endsAt: { gte: now } } } } });
  }
  if (audienceFilter === "SERVICE_BASED_CUSTOMERS") {
    const serviceId = audienceMeta?.serviceId;
    if (!serviceId) return [];
    return prisma.customer.findMany({
      where: {
        ...where,
        appointments: { some: { items: { some: { serviceId } } } }
      }
    });
  }
  return prisma.customer.findMany({ where, orderBy: { createdAt: "desc" } });
};
