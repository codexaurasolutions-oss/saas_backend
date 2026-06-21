import { z } from "zod";

const fieldLabelAliases = {
  durationMin: "Duration",
  monthlyPrice: "Monthly Price",
  yearlyPrice: "Yearly Price",
  trialDays: "Trial Days",
  branchLimit: "Branch Limit",
  userLimit: "User Limit",
  customerLimit: "Customer Limit",
  invoiceLimit: "Invoice Limit",
  storageLimit: "Storage Limit",
  taxRate: "Tax Rate",
  categoryId: "Service Category",
  gender: "Gender",
  roleTitle: "Role Title",
  ownerName: "Owner Name",
  ownerEmail: "Owner Email",
  ownerPassword: "Owner Password",
  loginAccessToken: "Secure Login Token",
  startsAt: "Start Date",
  endsAt: "End Date",
  userSalonId: "Staff User",
  serviceId: "Service",
  branchId: "Branch",
  salonId: "Salon ID",
  planId: "Plan ID",
  customerId: "Customer",
  staffUserId: "Assigned Staff",
  packageId: "Package",
  membershipPlanId: "Membership Plan",
  customRoleId: "Custom Role",
  customSlug: "Catalog Slug",
  catalogEnabled: "Catalog Enabled",
  googleReviewLink: "Google Review Link",
  themeColor: "Theme Color",
  beforeAfterGallery: "Before/After Gallery",
  orderId: "Order",
  fulfillmentMethod: "Fulfillment Method",
  audienceFilter: "Audience Filter",
  scheduledFor: "Schedule Time",
  type: "Template Type",
  content: "Template Content",
  company: "Salon Name",
  pointsPerCurrency: "Points Per Currency",
  minRedeemPoints: "Minimum Redeem Points",
  maxRedeemPercent: "Maximum Redemption Percent",
  discountValue: "Discount Value",
  usageLimit: "Usage Limit",
  customerUsageLimit: "Customer Usage Limit",
  minBillAmount: "Minimum Bill Amount",
  expenseDate: "Expense Date",
  periodStart: "Period Start",
  periodEnd: "Period End",
  eventKey: "Automation Event",
  templateType: "Template Type",
  incentiveAmount: "Incentive Amount"
};

const toFieldLabel = (path = []) => {
  const key = String(path[path.length - 1] || "request");
  if (fieldLabelAliases[key]) return fieldLabelAliases[key];
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .replace(/\bId\b/g, "ID");
};

const normalizeIssueMessage = (issue) => {
  const fieldLabel = toFieldLabel(issue.path);

  if (issue.code === "invalid_type" && issue.expected && issue.received === undefined) {
    return `${fieldLabel} is required`;
  }

  if (issue.code === "too_small") {
    if (issue.origin === "string") {
      if (String(issue.path?.[issue.path.length - 1] || "").endsWith("Id")) return `${fieldLabel} is required`;
      if (issue.minimum <= 1) return `${fieldLabel} is required`;
      if (issue.minimum <= 2) return `${fieldLabel} must be at least 2 characters`;
      return `${fieldLabel} must be at least ${issue.minimum} characters`;
    }
    if (issue.origin === "number") {
      return `${fieldLabel} must be at least ${issue.minimum}`;
    }
    if (issue.origin === "array") {
      return `${fieldLabel} must include at least ${issue.minimum} item${issue.minimum === 1 ? "" : "s"}`;
    }
  }

  if (issue.code === "too_big") {
    if (issue.origin === "string") return `${fieldLabel} must be at most ${issue.maximum} characters`;
    if (issue.origin === "number") return `${fieldLabel} must be at most ${issue.maximum}`;
  }

  if (issue.code === "invalid_value") {
    return `${fieldLabel} has an invalid value`;
  }

  if (issue.code === "invalid_enum_value") {
    return `${fieldLabel} must be one of: ${issue.options?.join(", ") || "valid options"}`;
  }

  if (issue.code === "invalid_string") {
    if (issue.validation === "email") return `${fieldLabel} must be a valid email address`;
    if (issue.validation === "url") return `${fieldLabel} must be a valid URL`;
    if (issue.validation === "regex") return `${fieldLabel} format is invalid`;
    return `${fieldLabel} format is invalid`;
  }

  return issue.message || "Invalid value";
};

export const validate = (schema) => (req, res, next) => {
  const parsed = schema.safeParse({ body: req.body, params: req.params, query: req.query });
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => ({
      ...issue,
      message: normalizeIssueMessage(issue),
      field: issue.path.filter((part) => part !== "body" && part !== "params" && part !== "query").join(".") || "request"
    }));
    const firstIssue = issues[0];
    return res.status(400).json({
      message: firstIssue ? `${firstIssue.field}: ${firstIssue.message}` : "Validation error",
      issues
    });
  }
  if (parsed.data.body) req.body = parsed.data.body;
  if (parsed.data.params) req.params = parsed.data.params;
  if (parsed.data.query) req.query = parsed.data.query;
  next();
};

const permissionMap = z.record(z.array(z.string()));
const idSchema = z.string().min(8);
const optionalString = z.string().optional();
const normalizeIndianPhone = (value) => {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  let digits = raw.replace(/\D/g, "");
  if (digits.startsWith("0091")) digits = digits.slice(4);
  else if (digits.startsWith("91") && digits.length > 10) digits = digits.slice(2);
  else if (digits.startsWith("0") && digits.length === 11) digits = digits.slice(1);
  return `+91${digits}`;
};
const indianPhoneSchema = z.string().trim()
  .transform(normalizeIndianPhone)
  .refine((value) => /^\+91\d{10}$/.test(value), "Enter a valid 10-digit Indian phone number");
const requiredIndianPhoneSchema = z.string().trim()
  .min(5, "Phone must be at least 5 characters")
  .transform(normalizeIndianPhone)
  .refine((value) => /^\+91\d{10}$/.test(value), "Enter a valid 10-digit Indian phone number");
const optionalIndianPhoneSchema = z.union([z.literal(""), indianPhoneSchema]).optional()
  .transform((value) => value || undefined);
const vendorPhoneSchema = z.string().trim().refine(
  (value) => /^\+91\d{10}$/.test(value),
  "Enter a valid +91 mobile number with 10 digits"
);
const optionalVendorPhoneSchema = z.union([z.literal(""), vendorPhoneSchema]).optional()
  .transform((value) => value || undefined);
const emailOrIndianPhoneSchema = z.string().trim().transform((value) => (
  value.includes("@") ? value : normalizeIndianPhone(value)
)).refine((value) => (
  value.includes("@")
    ? /^[^\s@]+@(?:[^\s@]+\.[^\s@]+|local)$/i.test(value)
    : /^\+91\d{10}$/.test(value)
), "Enter a valid email address or 10-digit Indian phone number");
const isValidDateString = (value) => !Number.isNaN(Date.parse(String(value)));
const requiredDateString = z.string().trim().min(1).pipe(z.string().refine(isValidDateString, "Invalid date"));
const optionalDateString = z.union([z.literal(""), z.string().trim().refine(isValidDateString, "Invalid date")]).optional();
const paymentModeEnum = z.enum(["CASH", "CARD", "UPI", "BANK_TRANSFER", "WALLET", "ONLINE"]);
const onlineOrderStatusEnum = z.enum(["NEW", "ACCEPTED", "READY", "COMPLETED", "CANCELLED"]);
const orderPaymentStatusEnum = z.enum(["PENDING", "PAID", "FAILED", "REFUNDED"]);
const emailLikeSchema = z.string().trim().refine(
  (value) => /^[^\s@]+@(?:[^\s@]+\.[^\s@]+|local)$/i.test(value),
  "Invalid email address"
);
const optionalEmailLike = z.union([emailLikeSchema, z.literal("")]).optional();

const invoiceItemSchema = z.object({
  itemType: z.enum(["SERVICE", "PRODUCT", "MEMBERSHIP", "PACKAGE", "GIFT_CARD"]).optional(),
  serviceId: z.string().optional(),
  productId: z.string().optional(),
  membershipPlanId: z.string().optional(),
  packageId: z.string().optional(),
  giftCardId: z.string().optional(),
  serviceName: z.string().min(1).optional(),
  staffUserId: z.string().optional(),
  staffName: z.string().optional(),
  qty: z.number().positive(),
  unitPrice: z.number().nonnegative().optional(),
  taxPct: z.number().min(0).default(0),
  packageSessionsUsed: z.number().int().min(0).optional(),
  membershipWalletUsed: z.number().min(0).optional(),
  validityDays: z.number().int().positive().optional(),
  gcCode: z.string().optional(),
  isCustom: z.boolean().optional(),
  customServices: z.array(z.any()).optional(),
  customProducts: z.array(z.any()).optional(),
  purchaseDate: z.string().optional()
}).refine((value) => value.serviceId || value.productId || value.membershipPlanId || value.packageId || value.giftCardId || value.serviceName, {
  message: "At least one invoice item reference or name is required"
});

const packageRedemptionSchema = z.object({
  customerPackageId: idSchema,
  serviceId: idSchema,
  sessionsUsed: z.number().int().positive().optional(),
  note: optionalString
});

const cartItemSchema = z.object({
  productId: idSchema,
  qty: z.number().int().positive()
});

const appointmentServiceItemSchema = z.object({
  serviceId: idSchema,
  staffUserIds: z.array(idSchema).min(1),
  startAt: requiredDateString,
  endAt: requiredDateString,
  notes: optionalString
});

export const schemas = {
  register: z.object({ body: z.object({ name: z.string().min(2), email: emailLikeSchema, password: z.string().min(6), systemRole: z.enum(["SUPER_ADMIN", "SALON_USER"]).optional(), salonId: z.string().optional() }) }),
  login: z.object({ body: z.object({ email: emailLikeSchema, password: z.string().min(6), loginAccessToken: z.string().optional() }) }),
  forgotPassword: z.object({ body: z.object({ email: emailLikeSchema }) }),
  validateResetToken: z.object({ body: z.object({ token: z.string().min(12) }) }),
  resetPassword: z.object({ body: z.object({ token: z.string().min(12), password: z.string().min(8) }) }),

  salon: z.object({
    body: z.object({
      name: z.string().min(2),
      slug: z.string().min(2),
      businessType: optionalString,
      logoUrl: optionalString,
      email: optionalEmailLike,
      phone: optionalIndianPhoneSchema,
      address: optionalString,
      city: optionalString,
      country: optionalString,
      timezone: optionalString,
      currency: optionalString,
      taxRate: z.number().min(0).optional(),
      trialStartsAt: optionalDateString,
      trialEndsAt: optionalDateString,
      internalNote: optionalString,
      ownerName: z.string().min(2).optional(),
      ownerEmail: optionalEmailLike,
      ownerPassword: z.string().min(6).optional(),
      featureFlags: z.record(z.boolean()).optional()
    })
  }),
  plan: z.object({
    body: z.object({
      name: z.string().min(1),
      monthlyPrice: z.number().min(0),
      yearlyPrice: z.number().min(0),
      trialDays: z.number().int().min(0),
      branchLimit: z.number().int().min(0),
      userLimit: z.number().int().min(0),
      customerLimit: z.number().int().min(0),
      invoiceLimit: z.number().int().min(0),
      storageLimit: z.number().int().min(0).optional(),
      isCustom: z.boolean().optional(),
      featureFlags: z.record(z.boolean()).optional()
    })
  }),
  subscription: z.object({
    body: z.object({
      salonId: idSchema,
      planId: idSchema,
      status: z.enum(["TRIAL", "ACTIVE", "EXPIRED", "SUSPENDED"]),
      paymentStatus: optionalString,
      manualDiscount: z.number().min(0).optional(),
      notes: optionalString,
      startsAt: requiredDateString,
      endsAt: requiredDateString
    })
  }),
  convertSubscription: z.object({
    body: z.object({
      planId: z.string().optional(),
      endsAt: optionalDateString,
      paymentStatus: z.string().optional(),
      manualDiscount: z.number().min(0).optional(),
      notes: z.string().optional()
    })
  }),
  branch: z.object({
    body: z.object({
      name: z.string().min(2),
      phone: optionalIndianPhoneSchema,
      email: optionalEmailLike,
      address: optionalString,
      businessHours: optionalString,
      weeklyOff: optionalString
    })
  }),
  service: z.object({
    body: z.object({
      name: z.string().min(2),
      price: z.number().nonnegative(),
      durationMin: z.number().int().positive(),
      branchId: z.string().optional(),
      categoryId: z.string().nullable().optional(),
      description: optionalString,
      gender: z.enum(["MALE", "FEMALE", "UNISEX"]).optional(),
      taxRate: z.number().min(0).optional(),
      onlineBookingEnabled: z.boolean().optional(),
      commissionPct: z.number().min(0).optional(),
      isFeatured: z.boolean().optional(),
      isPopular: z.boolean().optional()
    })
  }),
  customer: z.object({
    body: z.object({
      name: z.string().min(1),
      phone: requiredIndianPhoneSchema,
      email: optionalEmailLike,
      branchId: z.string().optional(),
      gender: optionalString,
      dateOfBirth: optionalDateString,
      anniversary: optionalDateString,
      source: optionalString,
      tags: z.array(z.string()).optional(),
      notes: optionalString,
      preferences: optionalString,
      preferredStaffId: z.string().optional(),
      allergies: optionalString,
      skinNotes: optionalString
    })
  }),
  customerPatch: z.object({
    body: z.object({
      name: z.string().min(2).optional(),
      phone: indianPhoneSchema.optional(),
      email: optionalEmailLike,
      branchId: z.string().optional(),
      gender: optionalString,
      dateOfBirth: optionalDateString,
      anniversary: optionalDateString,
      source: optionalString,
      tags: z.array(z.string()).optional(),
      notes: optionalString,
      preferences: optionalString,
      preferredStaffId: z.string().optional(),
      allergies: optionalString,
      skinNotes: optionalString
    }).refine((body) => Object.keys(body).length > 0, {
      message: "At least one customer field is required"
    })
  }),
  customerFollowUp: z.object({
    body: z.object({
      customerId: idSchema,
      staffUserId: idSchema,
      date: requiredDateString,
      time: optionalString,
      message: z.string().min(1),
      type: z.enum(["call", "sms", "whatsapp", "email", "visit"])
    })
  }),
  serviceCategory: z.object({ body: z.object({ name: z.string().min(2), parentId: z.string().nullable().optional() }) }),
  ownerUser: z.object({
    body: z.object({
      name: z.string().min(2),
      email: emailLikeSchema,
      password: z.string().min(6),
      salonRole: z.enum(["SALON_OWNER", "MANAGER", "RECEPTIONIST", "STAFF", "INVENTORY_MANAGER", "ACCOUNTANT"]),
      branchId: z.string().optional(),
      customRoleId: z.string().optional(),
      phone: optionalIndianPhoneSchema,
      profileNote: optionalString,
      avatarUrl: optionalString,
      roleTitle: optionalString,
      showInCatalog: z.boolean().optional(),
      serviceIds: z.array(z.string()).optional(),
      permissions: permissionMap.optional(),
      joiningDate: optionalDateString,
      designation: optionalString,
      uanNumber: optionalString,
      reportingToId: z.string().optional(),
      workingHours: optionalString,
      bankName: optionalString,
      bankBranch: optionalString,
      accountNumber: optionalString,
      ifscCode: optionalString
    })
  }),
  userMembershipUpdate: z.object({
    body: z.object({
      salonRole: z.enum(["SALON_OWNER", "MANAGER", "RECEPTIONIST", "STAFF", "INVENTORY_MANAGER", "ACCOUNTANT"]).optional(),
      branchId: z.string().nullable().optional(),
      customRoleId: z.string().nullable().optional(),
      phone: optionalIndianPhoneSchema,
      profileNote: optionalString,
      avatarUrl: optionalString,
      roleTitle: optionalString,
      showInCatalog: z.boolean().optional(),
      isArchived: z.boolean().optional(),
      serviceIds: z.array(z.string()).optional(),
      permissions: permissionMap.optional(),
      joiningDate: optionalDateString,
      designation: optionalString,
      uanNumber: optionalString,
      reportingToId: z.string().nullable().optional(),
      workingHours: optionalString,
      bankName: optionalString,
      bankBranch: optionalString,
      accountNumber: optionalString,
      ifscCode: optionalString
    })
  }),
  invoice: z.object({
    body: z.object({
      customerId: idSchema,
      branchId: z.string().optional(),
      appointmentId: z.string().optional(),
      appliedMembershipId: z.string().optional(),
      discount: z.number().min(0).default(0),
      tax: z.number().min(0).default(0),
      notes: z.string().optional(),
      couponCode: z.string().optional(),
      loyaltyPointsUsed: z.number().min(0).optional(),
      giftVoucherCode: z.string().optional(),
      items: z.array(invoiceItemSchema).min(1),
      packageRedemptions: z.array(packageRedemptionSchema).optional(),
      payments: z.array(z.object({
        mode: paymentModeEnum,
        amount: z.number().positive(),
        note: z.string().optional()
      })).default([])
    })
  }),
  payment: z.object({
    body: z.object({
      invoiceId: idSchema,
      amount: z.number().positive(),
      mode: paymentModeEnum,
      note: z.string().optional()
    })
  }),
  refundPayment: z.object({
    body: z.object({
      invoiceId: idSchema,
      amount: z.number().positive(),
      note: z.string().optional()
    })
  }),
  paymentLink: z.object({
    body: z.object({
      expiresAt: optionalDateString,
      gatewayName: z.string().optional(),
      note: z.string().optional()
    })
  }),
  paymentLinkLog: z.object({
    body: z.object({
      status: z.enum(["SENT", "FAILED", "PAID_PLACEHOLDER"]),
      note: z.string().optional(),
      gatewayRef: z.string().optional()
    })
  }),
  demoLead: z.object({
    body: z.object({
      name: z.string().min(2),
      email: emailLikeSchema,
      phone: indianPhoneSchema,
      company: z.string().min(2).optional(),
      message: z.string().optional()
    })
  }),
  demoLeadReview: z.object({
    body: z.object({
      planId: z.string().optional(),
      trialDays: z.number().int().min(1).max(30).optional(),
      salonName: z.string().min(2).optional(),
      businessType: z.string().optional(),
      reviewNote: z.string().optional()
    })
  }),
  demoLeadReject: z.object({ body: z.object({ reviewNote: z.string().min(2) }) }),
  supportTicket: z.object({ body: z.object({ title: z.string().min(2), category: z.string().optional(), priority: z.string().optional(), description: z.string().optional(), attachmentUrl: z.string().optional() }) }),
  supportTicketMessage: z.object({ body: z.object({ message: z.string().min(2), attachmentUrl: z.string().optional() }) }),
  salonSettings: z.object({ body: z.object({ invoicePrefix: z.string().optional(), invoiceFooter: z.string().optional(), taxLabel: z.string().optional(), paymentModes: z.any().optional(), whatsappNumber: optionalIndianPhoneSchema, bookingNotes: z.string().optional(), cancellationPolicy: z.string().optional(), branchId: z.string().nullable().optional(), paymentGatewaySettings: z.any().optional(), advancedSettings: z.any().optional(), smsSettings: z.any().optional(), allowNegativeStock: z.boolean().optional() }) }),
  customRole: z.object({ body: z.object({ name: z.string().min(2), description: z.string().optional(), permissions: permissionMap }) }),

  appointment: z.object({
    body: z.object({
      customerId: idSchema,
      branchId: idSchema,
      primaryStaffUserId: z.string().optional(),
      title: optionalString,
      bookingChannel: z.enum(["WALK_IN", "PHONE", "ONLINE_PLACEHOLDER", "MANUAL"]).default("MANUAL"),
      status: z.enum(["PENDING", "CONFIRMED", "CHECKED_IN", "IN_PROGRESS", "COMPLETED", "CANCELLED", "NO_SHOW"]).optional(),
      startAt: requiredDateString,
      endAt: requiredDateString,
      notes: optionalString,
      customerPreferences: optionalString,
      isWalkIn: z.boolean().optional(),
      advancePaymentRequired: z.boolean().optional(),
      advancePaidAmount: z.number().min(0).optional(),
      roomResourceNote: optionalString,
      items: z.array(appointmentServiceItemSchema).min(1)
    })
  }),
  appointmentStatus: z.object({
    body: z.object({
      status: z.enum(["PENDING", "CONFIRMED", "CHECKED_IN", "IN_PROGRESS", "COMPLETED", "CANCELLED", "NO_SHOW"]),
      note: optionalString
    })
  }),
  appointmentNote: z.object({
    body: z.object({
      note: optionalString
    })
  }),
  appointmentReschedule: z.object({
    body: z.object({
      startAt: requiredDateString,
      endAt: requiredDateString,
      note: optionalString,
      branchId: z.string().optional(),
      items: z.array(appointmentServiceItemSchema).optional()
    })
  }),
  appointmentSettings: z.object({
    body: z.object({
      branchId: z.string().nullable().optional(),
      autoConfirm: z.boolean().optional(),
      advancePaymentRequired: z.boolean().optional(),
      onlineBookingEnabled: z.boolean().optional()
    })
  }),
  staffSchedule: z.object({
    body: z.object({
      userSalonId: idSchema,
      branchId: z.string().nullable().optional(),
      weekday: z.number().int().min(0).max(6),
      startTime: z.string().regex(/^\d{2}:\d{2}$/),
      endTime: z.string().regex(/^\d{2}:\d{2}$/),
      isOffDay: z.boolean().optional()
    })
  }),
  staffBreak: z.object({
    body: z.object({
      userSalonId: idSchema,
      weekday: z.number().int().min(0).max(6),
      startTime: z.string().regex(/^\d{2}:\d{2}$/),
      endTime: z.string().regex(/^\d{2}:\d{2}$/)
    })
  }),

  productCategory: z.object({
    body: z.object({
      name: z.string().min(2),
      description: optionalString,
      imageUrl: optionalString,
      sortOrder: z.number().int().min(0).optional(),
      isPublicVisible: z.boolean().optional()
    })
  }),
  product: z.object({
    body: z.object({
      branchId: z.string().nullable().optional(),
      categoryId: z.string().nullable().optional(),
      name: z.string().min(2),
      imageUrl: optionalString,
      sku: optionalString,
      barcode: optionalString,
      productType: z.enum(["RETAIL", "CONSUMABLE"]),
      costPrice: z.number().min(0),
      sellingPrice: z.number().min(0),
      minStock: z.number().min(0).optional(),
      expiryDate: optionalDateString,
      allowNegativeStock: z.boolean().optional()
    })
  }),
  stockMovement: z.object({
    body: z.object({
      productId: idSchema,
      branchId: z.string().nullable().optional(),
      movementType: z.enum(["STOCK_IN", "STOCK_OUT", "ADJUSTMENT", "PRODUCT_RETURN", "CONSUMABLE_USAGE"]),
      quantity: z.number().positive(),
      note: optionalString
    })
  }),
  vendor: z.object({
    body: z.object({
      branchId: z.string().nullable().optional(),
      name: z.string().min(2),
      firmName: optionalString,
      phone: optionalVendorPhoneSchema,
      alternateMobile: optionalVendorPhoneSchema,
      email: optionalEmailLike,
      gstNumber: optionalString,
      address: optionalString,
      area: optionalString,
      landmark: optionalString,
      city: optionalString,
      pincode: optionalString,
      notes: optionalString,
      isActive: z.boolean().optional()
    })
  }),
  vendorItem: z.object({
    body: z.object({
      productId: idSchema,
      price: z.number().min(0),
      isActive: z.boolean().optional()
    })
  }),
  purchaseOrder: z.object({
    body: z.object({
      branchId: idSchema,
      vendorId: idSchema,
      notes: optionalString,
      items: z.array(z.object({
        productId: idSchema,
        quantityOrdered: z.number().positive(),
        unitCost: z.number().min(0),
        expiryDate: optionalDateString
      })).min(1)
    })
  }),
  purchaseReceive: z.object({
    body: z.object({
      items: z.array(z.object({
        purchaseOrderItemId: idSchema,
        quantityReceived: z.number().positive()
      })).min(1)
    })
  }),
  stockTransfer: z.object({
    body: z.object({
      fromBranchId: idSchema,
      toBranchId: idSchema,
      note: optionalString,
      items: z.array(z.object({
        productId: idSchema,
        quantity: z.number().positive()
      })).min(1)
    })
  }),
  stockReconciliation: z.object({
    body: z.object({
      branchId: idSchema,
      note: optionalString,
      items: z.array(z.object({
        productId: idSchema,
        physicalStock: z.number().min(0)
      })).min(1)
    })
  }),

  membershipPlan: z.object({
    body: z.object({
      name: z.string().min(2),
      description: optionalString,
      benefits: z.array(z.object({
        label: z.string().min(1),
        value: optionalString
      })).optional(),
      price: z.number().min(0),
      validityDays: z.number().int().positive(),
      benefitType: z.enum(["DISCOUNT_PERCENT", "DISCOUNT_AMOUNT", "WALLET_VALUE"]),
      discountValue: z.number().min(0).nullish(),
      walletValue: z.number().min(0).nullish(),
      serviceSpecificOnly: z.boolean().optional(),
      isActive: z.boolean().optional(),
      renewalReminder: z.number().int().min(0).optional(),
      sharable: z.boolean().optional(),
      maxShareCount: z.number().int().min(0).nullish(),
      serviceIds: z.array(idSchema).optional()
    })
  }),
  membershipRenew: z.object({
    body: z.object({
      note: optionalString
    })
  }),
  membershipTopUp: z.object({
    body: z.object({
      amount: z.number().positive(),
      note: optionalString
    })
  }),
  membershipUpgrade: z.object({
    body: z.object({
      membershipPlanId: idSchema,
      note: optionalString
    })
  }),
  membershipTransfer: z.object({
    body: z.object({
      customerId: idSchema,
      note: optionalString
    })
  }),
  assignMembership: z.object({
    body: z.object({
      customerId: idSchema,
      membershipPlanId: z.string(),
      soldInvoiceId: z.string().nullish(),
      startsAt: optionalDateString,
      staffId: z.string().optional().nullable(),
      price: z.number().optional(),
      validityDays: z.number().optional(),
      customServices: z.array(z.any()).optional(),
      isCustom: z.boolean().optional(),
      name: z.string().optional(),
      online: z.number().optional().nullable(),
      offline: z.number().optional().nullable(),
      balance: z.number().optional().nullable(),
      advance: z.number().optional().nullable(),
      remarks: z.string().optional().nullable()
    })
  }),
  packagePlan: z.object({
    body: z.object({
      name: z.string().min(2),
      price: z.number().min(0),
      totalSessions: z.number().int().positive(),
      validityDays: z.number().int().positive(),
      isActive: z.boolean().optional(),
      services: z.array(z.object({
        serviceId: idSchema,
        sessions: z.number().int().positive().optional()
      })).optional(),
      products: z.array(z.object({
        productId: idSchema,
        quantity: z.number().int().positive().optional()
      })).optional()
    })
  }),
  packageRenew: z.object({
    body: z.object({
      additionalSessions: z.number().int().min(0).optional(),
      note: optionalString
    })
  }),
  packageTransfer: z.object({
    body: z.object({
      customerId: idSchema,
      note: optionalString
    })
  }),
  assignPackage: z.object({
    body: z.object({
      customerId: idSchema,
      packageId: z.string(),
      soldInvoiceId: z.string().nullish(),
      startsAt: optionalDateString,
      staffId: z.string().optional().nullable(),
      price: z.number().optional(),
      validityDays: z.number().optional(),
      customServices: z.array(z.any()).optional(),
      isCustom: z.boolean().optional(),
      name: z.string().optional(),
      online: z.number().optional().nullable(),
      offline: z.number().optional().nullable(),
      balance: z.number().optional().nullable(),
      advance: z.number().optional().nullable(),
      remarks: z.string().optional().nullable(),
      notes: z.string().optional().nullable(),
      remark: z.string().optional().nullable()
    })
  }),
  packageRedeem: z.object({
    body: z.object({
      customerPackageId: idSchema,
      serviceId: idSchema,
      sessionsUsed: z.number().int().positive().optional(),
      invoiceId: z.string().nullish(),
      appointmentId: z.string().optional(),
      note: optionalString
    })
  }),

  catalogSettings: z.object({
    body: z.object({
      branchId: z.string().nullable().optional(),
      catalogEnabled: z.boolean().optional(),
      customSlug: z.string().min(2).optional(),
      logoUrl: optionalString,
      bannerUrl: optionalString,
      showServices: z.boolean().optional(),
      showPackages: z.boolean().optional(),
      showMemberships: z.boolean().optional(),
      showProducts: z.boolean().optional(),
      showStaffPortfolio: z.boolean().optional(),
      whatsappNumber: optionalString,
      googleReviewLink: optionalString,
      socialLinks: z.any().optional(),
      branchDisplaySettings: z.any().optional(),
      beforeAfterGallery: z.any().optional(),
      themeColor: optionalString,
      allowSuspendedCatalog: z.boolean().optional()
    })
  }),
  catalogBanner: z.object({
    body: z.object({
      title: z.string().min(2),
      subtitle: optionalString,
      imageUrl: optionalString,
      linkUrl: optionalString,
      sortOrder: z.number().int().min(0).optional(),
      isActive: z.boolean().optional()
    })
  }),
  catalogOffer: z.object({
    body: z.object({
      title: z.string().min(2),
      description: optionalString,
      imageUrl: optionalString,
      ctaLabel: optionalString,
      ctaUrl: optionalString,
      branchId: z.string().nullable().optional(),
      startsAt: optionalDateString,
      endsAt: optionalDateString,
      isActive: z.boolean().optional()
    })
  }),
  catalogEvent: z.object({
    body: z.object({
      eventType: z.enum(["QR_SCAN", "PAGE_VIEW", "SERVICE_VIEW", "PRODUCT_CLICK", "BOOKING_CLICK", "WHATSAPP_CLICK", "OFFER_CLICK", "SHOP_CLICK"]),
      branchId: z.string().nullable().optional(),
      serviceId: z.string().optional(),
      productId: z.string().optional(),
      offerId: z.string().optional(),
      metadata: z.any().optional()
    })
  }),
  publicBooking: z.object({
    body: z.object({
      customerName: z.string().min(2),
      customerPhone: indianPhoneSchema,
      customerEmail: optionalEmailLike,
      branchId: idSchema,
      primaryStaffUserId: z.string().optional(),
      startAt: requiredDateString,
      endAt: requiredDateString,
      notes: optionalString,
      customerPreferences: optionalString,
      items: z.array(appointmentServiceItemSchema).min(1)
    })
  }),
  ecommerceSettings: z.object({
    body: z.object({
      storeEnabled: z.boolean().optional(),
      allowCod: z.boolean().optional(),
      allowPayAtSalon: z.boolean().optional(),
      allowOnlinePayment: z.boolean().optional(),
      pickupEnabled: z.boolean().optional(),
      deliveryEnabled: z.boolean().optional(),
      deliveryNote: optionalString,
      supportPhone: optionalIndianPhoneSchema,
      termsText: optionalString
    })
  }),
  onlineVisibility: z.object({
    body: z.object({
      isOnlineVisible: z.boolean()
    })
  }),
  cartValidate: z.object({
    body: z.object({
      items: z.array(cartItemSchema).min(1)
    })
  }),
  createOrder: z.object({
    body: z.object({
      customerId: z.string().optional(),
      branchId: z.string().nullable().optional(),
      customerName: z.string().min(2),
      customerPhone: indianPhoneSchema,
      customerEmail: optionalEmailLike,
      note: optionalString,
      paymentMode: z.enum(["COD", "PAY_AT_SALON", "ONLINE_PLACEHOLDER"]).default("PAY_AT_SALON"),
      fulfillmentMethod: z.enum(["PICKUP", "DELIVERY"]).default("PICKUP"),
      couponCode: optionalString,
      giftCardCode: optionalString,
      items: z.array(cartItemSchema).min(1)
    })
  }),
  orderStatus: z.object({
    body: z.object({
      status: onlineOrderStatusEnum,
      note: optionalString,
      paymentStatus: orderPaymentStatusEnum.optional()
    })
  }),
  customerRegister: z.object({
    body: z.object({
      salonSlug: z.string().min(2),
      name: z.string().min(2),
      phone: indianPhoneSchema,
      email: optionalEmailLike,
      password: z.string().min(6)
    })
  }),
  customerLogin: z.object({
    body: z.object({
      salonSlug: z.string().min(2),
      emailOrPhone: emailOrIndianPhoneSchema,
      password: z.string().min(6)
    })
  }),
  customerProfile: z.object({
    body: z.object({
      name: z.string().min(2),
      phone: indianPhoneSchema,
      email: optionalEmailLike,
      preferences: optionalString,
      allergies: optionalString,
      skinNotes: optionalString
    })
  }),
  customerReschedule: z.object({
    body: z.object({
      startAt: requiredDateString,
      endAt: requiredDateString,
      note: optionalString
    })
  }),
  customerCancel: z.object({
    body: z.object({
      note: optionalString
    })
  }),
  customerFeedback: z.object({
    body: z.object({
      appointmentId: z.string().optional(),
      rating: z.number().int().min(1).max(5),
      message: optionalString
    })
  }),
  campaign: z.object({
    body: z.object({
      name: z.string().min(2),
      type: z.enum(["WHATSAPP", "SMS", "EMAIL", "SOCIAL_BANNER", "CATALOG_BANNER"]),
      audienceFilter: z.enum(["ALL_CUSTOMERS", "BIRTHDAY_CUSTOMERS", "ANNIVERSARY_CUSTOMERS", "LOST_CUSTOMERS", "HIGH_SPENDERS", "MEMBERSHIP_CUSTOMERS", "PACKAGE_CUSTOMERS", "SERVICE_BASED_CUSTOMERS", "CRM_SEGMENT"]),
      audienceMeta: z.any().optional(),
      message: optionalString,
      bannerUrl: optionalString,
      scheduledFor: optionalDateString
    })
  }),
  campaignAction: z.object({
    body: z.object({
      scheduledFor: optionalDateString,
      note: optionalString
    })
  }),
  messageTemplate: z.object({
    body: z.object({
      title: z.string().min(2),
      content: z.string().min(5),
      variables: z.any().optional()
    })
  }),
  messageTemplatePreview: z.object({
    body: z.object({
      customerId: z.string().optional(),
      appointmentId: z.string().optional(),
      invoiceId: z.string().optional(),
      orderId: z.string().optional(),
      customerMembershipId: z.string().optional(),
      customerPackageId: z.string().optional()
    })
  }),
  loyaltyRule: z.object({
    body: z.object({
      branchId: z.string().nullable().optional(),
      name: z.string().min(2),
      pointsPerCurrency: z.number().min(0),
      serviceMultiplier: z.number().min(0).optional(),
      productMultiplier: z.number().min(0).optional(),
      bonusRate: z.number().min(0).optional(),
      minRedeemPoints: z.number().int().min(0),
      maxRedeemPercent: z.number().min(0).max(100).optional(),
      expiryDays: z.number().int().min(0).optional(),
      birthdayPoints: z.number().int().min(0).optional(),
      referralPoints: z.number().int().min(0).optional(),
      isActive: z.boolean().optional(),
      notes: optionalString
    })
  }),
  loyaltyAdjust: z.object({
    body: z.object({
      customerId: idSchema,
      branchId: z.string().nullable().optional(),
      points: z.number().int(),
      type: z.enum(["ADJUST", "BONUS", "EXPIRE"]).default("ADJUST"),
      note: optionalString
    })
  }),
  coupon: z.object({
    body: z.object({
      branchId: z.string().nullable().optional(),
      serviceId: z.string().nullable().optional(),
      productId: z.string().nullable().optional(),
      code: z.string().min(2),
      title: z.string().min(2),
      description: optionalString,
      discountType: z.enum(["PERCENT", "FIXED"]),
      discountValue: z.number().min(0),
      minBillAmount: z.number().min(0).optional(),
      usageLimit: z.number().int().min(0).optional(),
      customerUsageLimit: z.number().int().min(0).optional(),
      startsAt: optionalDateString,
      endsAt: optionalDateString,
      isReferral: z.boolean().optional(),
      isInfluencer: z.boolean().optional(),
      isBirthday: z.boolean().optional(),
      isFestival: z.boolean().optional(),
      isArchived: z.boolean().optional(),
      notes: optionalString
    })
  }),
  couponValidate: z.object({
    body: z.object({
      code: z.string().min(2),
      customerId: z.string().optional(),
      branchId: z.string().nullable().optional(),
      serviceIds: z.array(idSchema).optional(),
      productIds: z.array(idSchema).optional(),
      subtotal: z.number().min(0)
    })
  }),
  giftCard: z.object({
    body: z.object({
      customerId: z.string().nullable().optional(),
      soldInvoiceId: z.string().nullable().optional(),
      linkedCampaignId: z.string().nullable().optional(),
      code: z.string().min(2),
      title: z.string().min(2),
      originalAmount: z.number().positive(),
      balanceAmount: z.number().min(0).optional(),
      expiresAt: optionalDateString,
      isActive: z.boolean().optional(),
      note: optionalString
    })
  }),
  giftCardRedeem: z.object({
      body: z.object({
        giftCardId: z.string().optional(),
        id: z.string().optional(),
        customerId: z.string().nullable().optional(),
        invoiceId: z.string().nullable().optional(),
        orderId: z.string().nullable().optional(),
        amountUsed: z.number().positive()
      }).refine((body) => Boolean(body.giftCardId || body.id), {
        message: "giftCardId is required",
        path: ["giftCardId"]
      })
    }),
  feedbackStatus: z.object({
    body: z.object({
      status: z.enum(["NEW", "REVIEWED", "CONTACTED", "RESOLVED"]),
      internalNotes: optionalString,
      complaintFollowUpStatus: optionalString
    })
  }),
  feedbackFollowUp: z.object({
    body: z.object({
      note: z.string().min(2)
    })
  }),
  enquiry: z.object({
    body: z.object({
      name: z.string().min(2),
      phone: indianPhoneSchema,
      email: optionalEmailLike,
      source: z.enum(["WEBSITE", "WHATSAPP", "PHONE", "WALK_IN", "INSTAGRAM", "FACEBOOK", "ADS", "REFERRAL"]),
      interestedServiceId: z.string().nullable().optional(),
      interestedBranchId: z.string().nullable().optional(),
      budget: z.number().min(0).optional(),
      priority: optionalString,
      assignedToMembershipId: z.string().nullable().optional(),
      followUpAt: optionalDateString,
      notes: optionalString
    })
  }),
  enquiryStatus: z.object({
    body: z.object({
      status: z.enum(["NEW", "CONTACTED", "INTERESTED", "CONVERTED", "LOST"]),
      note: optionalString
    })
  }),
  enquiryFollowUp: z.object({
    body: z.object({
      note: z.string().min(2),
      status: optionalString,
      dueAt: optionalDateString
    })
  }),
  expenseCategory: z.object({
    body: z.object({
      name: z.string().min(2),
      description: optionalString
    })
  }),
  expense: z.object({
    body: z.object({
      branchId: z.string().nullable().optional(),
      categoryId: z.string().nullable().optional(),
      vendorId: z.string().nullable().optional(),
      title: z.string().min(2),
      amount: z.number().positive(),
      expenseDate: requiredDateString,
      paymentMode: paymentModeEnum.optional(),
      status: z.enum(["PENDING", "APPROVED", "REJECTED", "PAID"]).optional(),
      notes: optionalString,
      receiptUrl: optionalString,
      attachmentUrl: optionalString
    })
  }),
  expenseApproval: z.object({
    body: z.object({
      approvalNote: optionalString
    })
  }),
  attendance: z.object({
    body: z.object({
      userSalonId: idSchema,
      branchId: z.string().nullable().optional(),
      checkInAt: optionalDateString,
      checkOutAt: optionalDateString,
      note: optionalString
    })
  }),
  leaveRequest: z.object({
    body: z.object({
      userSalonId: z.string().optional(),
      startDate: requiredDateString,
      endDate: requiredDateString,
      reason: optionalString,
      note: optionalString
    })
  }),
  leaveStatus: z.object({
    body: z.object({
      note: optionalString
    })
  }),
  incentiveRule: z.object({
    body: z.object({
      name: z.string().min(2),
      targetType: z.enum(["SERVICE", "PRODUCT", "MEMBERSHIP", "PACKAGE"]),
      minTarget: z.number().min(0).optional(),
      incentiveAmount: z.number().min(0),
      isActive: z.boolean().optional(),
      notes: optionalString
    })
  }),
  payrollRun: z.object({
    body: z.object({
      branchId: z.string().nullable().optional(),
      periodStart: requiredDateString,
      periodEnd: requiredDateString,
      notes: optionalString
    })
  }),
  payrollStatus: z.object({
    body: z.object({
      note: optionalString
    })
  }),
  campaignTemplate: z.object({
    body: z.object({
      name: z.string().min(2),
      title: z.string().min(2),
      tier: z.enum(["FREE", "PREMIUM"]).optional(),
      category: optionalString,
      backgroundColor: optionalString,
      textColor: optionalString,
      offerText: optionalString,
      logoUrl: optionalString,
      imageUrl: optionalString,
      layoutJson: z.any().optional(),
      isActive: z.boolean().optional()
    })
  }),
  linkCoupon: z.object({
    body: z.object({
      couponId: idSchema
    })
  }),
  whatsappSettings: z.object({
    body: z.object({
      providerName: optionalString,
      senderName: optionalString,
      apiUrl: optionalString,
      apiKeyPlaceholder: optionalString,
      automationEnabled: z.boolean().optional(),
      deliveryStatusEnabled: z.boolean().optional(),
      readStatusEnabled: z.boolean().optional()
    })
  }),
  whatsappSend: z.object({
    body: z.object({
      customerId: z.string().nullable().optional(),
      campaignId: z.string().nullable().optional(),
      channel: z.enum(["EMAIL", "WHATSAPP", "SMS"]).optional(),
      phone: indianPhoneSchema.optional(),
      email: z.string().email().nullable().optional(),
      templateType: optionalString,
      message: z.string().min(2),
      mediaKind: optionalString,
      mediaUrl: optionalString
    }).superRefine((value, ctx) => {
      const channel = String(value.channel || "EMAIL").toUpperCase();
      if (channel === "EMAIL") {
        if (!String(value.email || "").trim()) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["email"],
            message: "Email is required for email delivery"
          });
        }
        return;
      }

      if (!String(value.phone || "").trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["phone"],
          message: "Phone is required for WhatsApp or SMS delivery"
        });
      }
    })
  }),
  whatsappAutomation: z.object({
    body: z.object({
      eventKey: z.string().min(2),
      templateType: z.string().min(2),
      audienceFilter: optionalString,
      mediaKind: optionalString,
      mediaUrl: optionalString,
      isEnabled: z.boolean().optional(),
      notes: optionalString
    })
  }),
  whatsappLogStatus: z.object({
    body: z.object({
      status: z.enum(["SENT", "DELIVERED", "READ", "FAILED", "OPEN_PLACEHOLDER"])
    })
  }),
  whatsappReplyPlaceholder: z.object({
    body: z.object({
      replyNote: z.string().min(2)
    })
  }),
  notificationTest: z.object({
    body: z.object({
      userSalonId: z.string().nullable().optional(),
      title: z.string().min(2),
      message: z.string().min(2),
      linkUrl: optionalString
    })
  })
};
