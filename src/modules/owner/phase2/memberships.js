import { prisma } from "../../../lib/prisma.js";
import { logCustomerTimeline } from "../../../lib/phase2.js";
import { createPosInvoice } from "../../../lib/pos.js";
import { requireSalonPermission } from "../../../middlewares/rbac.js";
import { schemas, validate } from "../../../middlewares/validate.js";

export const registerMembershipRoutes = (ownerRouter) => {
  ownerRouter.get("/memberships/plans", async (req, res) => {
    res.json(await prisma.membershipPlan.findMany({ where: { salonId: req.salonId, isActive: true }, include: { services: { include: { service: true } } } }));
  });

  ownerRouter.get("/memberships", requireSalonPermission("memberships", "view"), async (req, res) => {
    res.json(await prisma.membershipPlan.findMany({ where: { salonId: req.salonId }, include: { services: { include: { service: true } } }, orderBy: { createdAt: "desc" } }));
  });

  ownerRouter.get("/memberships/:id", requireSalonPermission("memberships", "view"), async (req, res) => {
    const plan = await prisma.membershipPlan.findFirst({
      where: { id: req.params.id, salonId: req.salonId },
      include: { services: { include: { service: true } } }
    });
    if (!plan) return res.status(404).json({ message: "Membership plan not found" });
    res.json(plan);
  });

  ownerRouter.post("/memberships", requireSalonPermission("memberships", "create"), validate(schemas.membershipPlan), async (req, res) => {
    const created = await prisma.$transaction(async (tx) => {
      const plan = await tx.membershipPlan.create({
        data: {
          salonId: req.salonId,
          name: req.body.name,
          price: req.body.price,
          validityDays: req.body.validityDays,
          benefitType: req.body.benefitType,
          discountValue: req.body.discountValue ?? null,
          walletValue: req.body.walletValue ?? null,
          serviceSpecificOnly: Boolean(req.body.serviceSpecificOnly),
          isActive: req.body.isActive ?? true,
          renewalReminder: req.body.renewalReminder != null ? Number(req.body.renewalReminder) : undefined,
          sharable: req.body.sharable != null ? Boolean(req.body.sharable) : undefined,
          maxShareCount: req.body.maxShareCount != null ? Number(req.body.maxShareCount) : null
        }
      });
      if (req.body.serviceIds?.length) {
        await tx.membershipPlanService.createMany({
          data: req.body.serviceIds.map((serviceId) => ({ membershipPlanId: plan.id, serviceId })),
          skipDuplicates: true
        });
      }
      return tx.membershipPlan.findUnique({ where: { id: plan.id }, include: { services: { include: { service: true } } } });
    });
    res.status(201).json(created);
  });

  ownerRouter.patch("/memberships/:id", requireSalonPermission("memberships", "edit"), validate(schemas.membershipPlan), async (req, res) => {
    const plan = await prisma.membershipPlan.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
    if (!plan) return res.status(404).json({ message: "Membership plan not found" });
    const updated = await prisma.$transaction(async (tx) => {
      await tx.membershipPlan.update({
        where: { id: plan.id },
        data: {
          name: req.body.name,
          price: req.body.price,
          validityDays: req.body.validityDays,
          benefitType: req.body.benefitType,
          discountValue: req.body.discountValue ?? null,
          walletValue: req.body.walletValue ?? null,
          serviceSpecificOnly: Boolean(req.body.serviceSpecificOnly),
          isActive: req.body.isActive ?? true,
          renewalReminder: req.body.renewalReminder != null ? Number(req.body.renewalReminder) : undefined,
          sharable: req.body.sharable != null ? Boolean(req.body.sharable) : undefined,
          maxShareCount: req.body.maxShareCount != null ? Number(req.body.maxShareCount) : null
        }
      });
      await tx.membershipPlanService.deleteMany({ where: { membershipPlanId: plan.id } });
      if (req.body.serviceIds?.length) {
        await tx.membershipPlanService.createMany({
          data: req.body.serviceIds.map((serviceId) => ({ membershipPlanId: plan.id, serviceId })),
          skipDuplicates: true
        });
      }
      return tx.membershipPlan.findUnique({ where: { id: plan.id }, include: { services: { include: { service: true } } } });
    });
    res.json(updated);
  });

  ownerRouter.post("/memberships/assign", requireSalonPermission("memberships", "create"), validate(schemas.assignMembership), async (req, res) => {
    try {
      let plan;
      if (req.body.isCustom || req.body.membershipPlanId === "CUSTOM") {
        plan = await prisma.membershipPlan.create({
          data: {
            salonId: req.salonId,
            name: req.body.name || "Custom Membership",
            price: Number(req.body.price || 0),
            validityDays: Number(req.body.validityDays || 30),
            benefitType: "DISCOUNT_PERCENT",
            discountValue: 0,
            isPublicVisible: false,
            isActive: true
          }
        });
        if (req.body.customServices && req.body.customServices.length > 0) {
          await prisma.membershipPlanService.createMany({
            data: req.body.customServices.map(s => {
              const serviceId = typeof s === 'string' ? s : (s.id || s.serviceId);
              return { membershipPlanId: plan.id, serviceId };
            })
          });
        }
      } else {
        plan = await prisma.membershipPlan.findFirst({ where: { id: req.body.membershipPlanId, salonId: req.salonId, isActive: true } });
      }
      if (!plan) return res.status(404).json({ message: "Membership plan not found" });
      const startsAt = req.body.startsAt ? new Date(req.body.startsAt) : new Date();
      const endsAt = new Date(startsAt.getTime() + plan.validityDays * 24 * 60 * 60 * 1000);
      const created = await prisma.customerMembership.create({
        data: {
          salonId: req.salonId,
          customerId: req.body.customerId,
          membershipPlanId: plan.id,
          soldInvoiceId: req.body.soldInvoiceId || null,
          startsAt,
          endsAt,
          remainingWalletValue: plan.benefitType === "WALLET_VALUE" ? plan.walletValue : null,
          remarks: req.body.remarks || null
        },
        include: { membershipPlan: true }
      });
      await prisma.$transaction(async (tx) => {
        await logCustomerTimeline(tx, req.body.customerId, "MEMBERSHIP", "Membership assigned", plan.name, created.id);
      });

      // Auto-generate invoice for the membership sale
      let invoice = null;
      try {
        const finalPrice = req.body.price != null ? Number(req.body.price) : Number(plan.price);
        const payments = [];
        if (req.body.online != null && Number(req.body.online) > 0) {
          payments.push({ mode: "ONLINE", amount: Number(req.body.online), note: "Online payment" });
        }
        if (req.body.offline != null && Number(req.body.offline) > 0) {
          payments.push({ mode: "CASH", amount: Number(req.body.offline), note: "Offline payment" });
        }
        if (req.body.advance != null && Number(req.body.advance) > 0) {
          payments.push({ mode: "CASH", amount: Number(req.body.advance), note: "Advance payment" });
        }

        if (payments.length === 0 && finalPrice > 0) {
          payments.push({ mode: req.body.paymentMode || "CASH", amount: finalPrice, note: `Membership: ${plan.name}` });
        }

        invoice = await createPosInvoice({
          salonId: req.salonId,
          actorUser: req.user,
          body: {
            customerId: req.body.customerId,
            branchId: req.body.branchId || null,
            items: [{
              itemType: "MEMBERSHIP",
              membershipPlanId: plan.id,
              serviceName: plan.name,
              unitPrice: finalPrice,
              qty: 1,
              taxPct: 0,
              staffUserId: req.body.staffId || null
            }],
            payments,
            notes: req.body.remarks || `Membership assigned: ${plan.name}`
          }
        });
        // Link the invoice to the membership record
        await prisma.customerMembership.update({ where: { id: created.id }, data: { soldInvoiceId: invoice.id } });
      } catch (invoiceErr) {
        console.error("[assign-membership] Invoice creation failed (non-blocking):", invoiceErr.message);
      }

      res.status(201).json({ assignment: created, invoice: invoice || null });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: err.message || "Failed to assign membership" });
    }
  });

  ownerRouter.post("/customer-memberships/:id/renew", requireSalonPermission("memberships", "edit"), validate(schemas.membershipRenew), async (req, res) => {
    const membership = await prisma.customerMembership.findFirst({
      where: { id: req.params.id, salonId: req.salonId },
      include: { membershipPlan: true }
    });
    if (!membership) return res.status(404).json({ message: "Customer membership not found" });
    const anchorDate = new Date(membership.endsAt) > new Date() ? new Date(membership.endsAt) : new Date();
    const nextEnd = new Date(anchorDate.getTime() + membership.membershipPlan.validityDays * 24 * 60 * 60 * 1000);
    const result = await prisma.$transaction(async (tx) => {
      const updated = await tx.customerMembership.update({
        where: { id: membership.id },
        data: { status: "ACTIVE", endsAt: nextEnd }
      });
      await logCustomerTimeline(tx, membership.customerId, "MEMBERSHIP_RENEWAL", "Membership renewed", req.body.note || membership.membershipPlan.name, membership.id);
      return updated;
    });
    res.json(result);
  });

  ownerRouter.post("/customer-memberships/:id/top-up", requireSalonPermission("memberships", "edit"), validate(schemas.membershipTopUp), async (req, res) => {
    const membership = await prisma.customerMembership.findFirst({
      where: { id: req.params.id, salonId: req.salonId },
      include: { membershipPlan: true }
    });
    if (!membership) return res.status(404).json({ message: "Customer membership not found" });
    const result = await prisma.$transaction(async (tx) => {
      const updated = await tx.customerMembership.update({
        where: { id: membership.id },
        data: {
          status: "ACTIVE",
          remainingWalletValue: Number(membership.remainingWalletValue || 0) + Number(req.body.amount || 0)
        }
      });
      await tx.membershipUsage.create({
        data: {
          customerMembershipId: membership.id,
          amountUsed: -req.body.amount,
          note: req.body.note || "Membership wallet top-up placeholder"
        }
      });
      await logCustomerTimeline(tx, membership.customerId, "MEMBERSHIP_TOP_UP", "Membership top-up", `${req.body.amount}`, membership.id);
      return updated;
    });
    res.json(result);
  });

  ownerRouter.post("/customer-memberships/:id/upgrade", requireSalonPermission("memberships", "edit"), validate(schemas.membershipUpgrade), async (req, res) => {
    const membership = await prisma.customerMembership.findFirst({
      where: { id: req.params.id, salonId: req.salonId },
      include: { membershipPlan: true }
    });
    if (!membership) return res.status(404).json({ message: "Customer membership not found" });
    const newPlan = await prisma.membershipPlan.findFirst({
      where: { id: req.body.membershipPlanId, salonId: req.salonId, isActive: true }
    });
    if (!newPlan) return res.status(404).json({ message: "Membership plan not found" });
    const startsAt = new Date();
    const endsAt = new Date(startsAt.getTime() + newPlan.validityDays * 24 * 60 * 60 * 1000);
    const result = await prisma.$transaction(async (tx) => {
      const updated = await tx.customerMembership.update({
        where: { id: membership.id },
        data: {
          membershipPlanId: newPlan.id,
          startsAt,
          endsAt,
          status: "ACTIVE",
          remainingWalletValue: newPlan.benefitType === "WALLET_VALUE" ? newPlan.walletValue : membership.remainingWalletValue
        }
      });
      await logCustomerTimeline(tx, membership.customerId, "MEMBERSHIP_UPGRADE", "Membership upgraded", req.body.note || `${membership.membershipPlan.name} -> ${newPlan.name}`, membership.id);
      return updated;
    });
    res.json(result);
  });

  ownerRouter.post("/customer-memberships/:id/transfer", requireSalonPermission("memberships", "edit"), validate(schemas.membershipTransfer), async (req, res) => {
    const membership = await prisma.customerMembership.findFirst({
      where: { id: req.params.id, salonId: req.salonId }
    });
    if (!membership) return res.status(404).json({ message: "Customer membership not found" });
    const targetCustomer = await prisma.customer.findFirst({ where: { id: req.body.customerId, salonId: req.salonId } });
    if (!targetCustomer) return res.status(404).json({ message: "Target customer not found" });
    const result = await prisma.$transaction(async (tx) => {
      const updated = await tx.customerMembership.update({
        where: { id: membership.id },
        data: { customerId: targetCustomer.id }
      });
      await logCustomerTimeline(tx, membership.customerId, "MEMBERSHIP_TRANSFER_OUT", "Membership transferred out", req.body.note || targetCustomer.name, membership.id);
      await logCustomerTimeline(tx, targetCustomer.id, "MEMBERSHIP_TRANSFER_IN", "Membership transferred in", req.body.note || membership.id, membership.id);
      return updated;
    });
    res.json(result);
  });

  ownerRouter.get("/packages", requireSalonPermission("packages", "view"), async (req, res) => {
    res.json(await prisma.package.findMany({ where: { salonId: req.salonId }, include: { services: { include: { service: true } } }, orderBy: { createdAt: "desc" } }));
  });

  ownerRouter.get("/packages/:id", requireSalonPermission("packages", "view"), async (req, res) => {
    const pack = await prisma.package.findFirst({
      where: { id: req.params.id, salonId: req.salonId },
      include: { services: { include: { service: true } } }
    });
    if (!pack) return res.status(404).json({ message: "Package not found" });
    res.json(pack);
  });

  ownerRouter.post("/packages", requireSalonPermission("packages", "create"), validate(schemas.packagePlan), async (req, res) => {
    const created = await prisma.$transaction(async (tx) => {
      const pack = await tx.package.create({
        data: {
          salonId: req.salonId,
          name: req.body.name,
          price: req.body.price,
          totalSessions: req.body.totalSessions,
          validityDays: req.body.validityDays,
          isActive: req.body.isActive ?? true
        }
      });
      await tx.packageService.createMany({
        data: req.body.services.map((item) => ({ packageId: pack.id, serviceId: item.serviceId, sessions: item.sessions || 1 })),
        skipDuplicates: true
      });
      return tx.package.findUnique({ where: { id: pack.id }, include: { services: { include: { service: true } } } });
    });
    res.status(201).json(created);
  });

  ownerRouter.patch("/packages/:id", requireSalonPermission("packages", "edit"), validate(schemas.packagePlan), async (req, res) => {
    const pack = await prisma.package.findFirst({ where: { id: req.params.id, salonId: req.salonId } });
    if (!pack) return res.status(404).json({ message: "Package not found" });
    const updated = await prisma.$transaction(async (tx) => {
      await tx.package.update({
        where: { id: pack.id },
        data: {
          name: req.body.name,
          price: req.body.price,
          totalSessions: req.body.totalSessions,
          validityDays: req.body.validityDays,
          isActive: req.body.isActive ?? true
        }
      });
      await tx.packageService.deleteMany({ where: { packageId: pack.id } });
      await tx.packageService.createMany({
        data: req.body.services.map((item) => ({ packageId: pack.id, serviceId: item.serviceId, sessions: item.sessions || 1 })),
        skipDuplicates: true
      });
      return tx.package.findUnique({ where: { id: pack.id }, include: { services: { include: { service: true } } } });
    });
    res.json(updated);
  });

  ownerRouter.post("/packages/assign", requireSalonPermission("packages", "create"), validate(schemas.assignPackage), async (req, res) => {
    try {
      let pack;
      if (req.body.isCustom || req.body.packageId === "CUSTOM") {
        pack = await prisma.package.create({
          data: {
            salonId: req.salonId,
            name: req.body.name || "Custom Package",
            price: Number(req.body.price || 0),
            totalSessions: req.body.customServices ? req.body.customServices.length : 1,
            validityDays: Number(req.body.validityDays || 30),
            isPublicVisible: false,
            isActive: true
          }
        });
        if (req.body.customServices && req.body.customServices.length > 0) {
          await prisma.packageService.createMany({
            data: req.body.customServices.map(s => {
              const serviceId = typeof s === 'string' ? s : (s.id || s.serviceId);
              const sessions = typeof s === 'string' ? 1 : (s.sessions || s.qty || 1);
              return { packageId: pack.id, serviceId, sessions };
            })
          });
        }
      } else {
        pack = await prisma.package.findFirst({ where: { id: req.body.packageId, salonId: req.salonId, isActive: true } });
      }
      if (!pack) return res.status(404).json({ message: "Package not found" });
      const startsAt = req.body.startsAt ? new Date(req.body.startsAt) : new Date();
      const endsAt = new Date(startsAt.getTime() + pack.validityDays * 24 * 60 * 60 * 1000);
      const created = await prisma.customerPackage.create({
        data: {
          salonId: req.salonId,
          customerId: req.body.customerId,
          packageId: pack.id,
          soldInvoiceId: req.body.soldInvoiceId || null,
          startsAt,
          endsAt,
          remainingSessions: pack.totalSessions
        },
        include: { package: true }
      });
      await prisma.$transaction(async (tx) => {
        await logCustomerTimeline(tx, req.body.customerId, "PACKAGE", "Package assigned", pack.name, created.id);
      });

      // Auto-generate invoice for the package sale
      let invoice = null;
      try {
        const finalPrice = req.body.price != null ? Number(req.body.price) : Number(pack.price);
        invoice = await createPosInvoice({
          salonId: req.salonId,
          actorUser: req.user,
          body: {
            customerId: req.body.customerId,
            branchId: req.body.branchId || null,
            items: [{
              itemType: "PACKAGE",
              packageId: pack.id,
              serviceName: pack.name,
              unitPrice: finalPrice,
              qty: 1,
              taxPct: 0,
              staffUserId: req.body.staffId || null
            }],
            payments: finalPrice > 0 ? [{ mode: req.body.paymentMode || "CASH", amount: finalPrice, note: `Package: ${pack.name}` }] : [],
            notes: `Package assigned: ${pack.name}`
          }
        });
        // Link the invoice to the package record
        await prisma.customerPackage.update({ where: { id: created.id }, data: { soldInvoiceId: invoice.id } });
      } catch (invoiceErr) {
        console.error("[assign-package] Invoice creation failed (non-blocking):", invoiceErr.message);
      }

      res.status(201).json({ assignment: created, invoice: invoice || null });
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: err.message || "Failed to assign package" });
    }
  });

  ownerRouter.post("/customer-packages/:id/renew", requireSalonPermission("packages", "edit"), validate(schemas.packageRenew), async (req, res) => {
    const customerPackage = await prisma.customerPackage.findFirst({
      where: { id: req.params.id, salonId: req.salonId },
      include: { package: true }
    });
    if (!customerPackage) return res.status(404).json({ message: "Customer package not found" });
    const anchorDate = new Date(customerPackage.endsAt) > new Date() ? new Date(customerPackage.endsAt) : new Date();
    const nextEnd = new Date(anchorDate.getTime() + customerPackage.package.validityDays * 24 * 60 * 60 * 1000);
    const result = await prisma.$transaction(async (tx) => {
      const updated = await tx.customerPackage.update({
        where: { id: customerPackage.id },
        data: {
          status: "ACTIVE",
          endsAt: nextEnd,
          remainingSessions: customerPackage.remainingSessions + Number(req.body.additionalSessions || 0)
        }
      });
      await logCustomerTimeline(tx, customerPackage.customerId, "PACKAGE_RENEWAL", "Package renewed", req.body.note || customerPackage.package.name, customerPackage.id);
      return updated;
    });
    res.json(result);
  });

  ownerRouter.post("/customer-packages/:id/transfer", requireSalonPermission("packages", "edit"), validate(schemas.packageTransfer), async (req, res) => {
    const customerPackage = await prisma.customerPackage.findFirst({
      where: { id: req.params.id, salonId: req.salonId }
    });
    if (!customerPackage) return res.status(404).json({ message: "Customer package not found" });
    const targetCustomer = await prisma.customer.findFirst({ where: { id: req.body.customerId, salonId: req.salonId } });
    if (!targetCustomer) return res.status(404).json({ message: "Target customer not found" });
    const result = await prisma.$transaction(async (tx) => {
      const updated = await tx.customerPackage.update({
        where: { id: customerPackage.id },
        data: { customerId: targetCustomer.id }
      });
      await logCustomerTimeline(tx, customerPackage.customerId, "PACKAGE_TRANSFER_OUT", "Package transferred out", req.body.note || targetCustomer.name, customerPackage.id);
      await logCustomerTimeline(tx, targetCustomer.id, "PACKAGE_TRANSFER_IN", "Package transferred in", req.body.note || customerPackage.id, customerPackage.id);
      return updated;
    });
    res.json(result);
  });

  ownerRouter.post("/packages/redeem", requireSalonPermission("packages", "edit"), validate(schemas.packageRedeem), async (req, res) => {
    const customerPackage = await prisma.customerPackage.findFirst({
      where: { id: req.body.customerPackageId, salonId: req.salonId },
      include: { package: true }
    });
    if (!customerPackage) return res.status(404).json({ message: "Customer package not found" });
    if (customerPackage.status !== "ACTIVE" || new Date(customerPackage.endsAt) < new Date()) {
      return res.status(400).json({ message: "Expired or inactive package cannot be redeemed" });
    }
    const sessionsUsed = req.body.sessionsUsed || 1;
    if (customerPackage.remainingSessions < sessionsUsed) {
      return res.status(400).json({ message: "Not enough package sessions remaining" });
    }
    const result = await prisma.$transaction(async (tx) => {
      const updated = await tx.customerPackage.update({
        where: { id: customerPackage.id },
        data: {
          remainingSessions: customerPackage.remainingSessions - sessionsUsed,
          status: customerPackage.remainingSessions - sessionsUsed <= 0 ? "FULLY_USED" : customerPackage.status
        }
      });
      await tx.packageUsage.create({
        data: {
          customerPackageId: customerPackage.id,
          invoiceId: req.body.invoiceId || null,
          appointmentId: req.body.appointmentId || null,
          serviceId: req.body.serviceId,
          sessionsUsed,
          note: req.body.note || null
        }
      });
      await logCustomerTimeline(tx, customerPackage.customerId, "PACKAGE_REDEMPTION", "Package redeemed", `${sessionsUsed} session(s) used`, customerPackage.id);
      return updated;
    });
    res.json(result);
  });

  ownerRouter.get("/customers/:id/history", requireSalonPermission("customers", "view"), async (req, res) => {
    const customer = await prisma.customer.findFirst({
      where: { id: req.params.id, salonId: req.salonId },
      include: {
        appointments: { include: { branch: true, items: { include: { service: true } } }, orderBy: { startAt: "desc" } },
        invoices: { include: { items: true, payments: true, branch: true }, orderBy: { createdAt: "desc" } },
        memberships: { include: { membershipPlan: { include: { services: { include: { service: true } } } }, usageLogs: true }, orderBy: { createdAt: "desc" } },
        packages: { include: { package: { include: { services: { include: { service: true } } } }, usageLogs: true }, orderBy: { createdAt: "desc" } },
        timelineEntries: { orderBy: { createdAt: "desc" } }
      }
    });
    if (!customer) return res.status(404).json({ message: "Customer not found" });
    res.json(customer);
  });
};
