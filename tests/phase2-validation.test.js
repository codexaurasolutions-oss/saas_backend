import { describe, expect, it } from "vitest";

import { schemas } from "../src/middlewares/validate.js";

describe("phase2 validation schemas", () => {
  it("allows nullish membership amount fields for plan forms", () => {
    const parsed = schemas.membershipPlan.parse({
      body: {
        name: "Gold Membership",
        price: 1200,
        validityDays: 30,
        benefitType: "DISCOUNT_AMOUNT",
        discountValue: null,
        walletValue: null,
        serviceSpecificOnly: false,
        isActive: true,
        serviceIds: []
      }
    });

    expect(parsed.body.discountValue).toBeNull();
    expect(parsed.body.walletValue).toBeNull();
  });

  it("allows null soldInvoiceId and invoiceId in loyalty flows", () => {
    expect(() => schemas.assignMembership.parse({
      body: {
        customerId: "customer-1",
        membershipPlanId: "membership-plan-1",
        soldInvoiceId: null,
        staffId: "staff-001"
      }
    })).not.toThrow();

    expect(() => schemas.assignPackage.parse({
      body: {
        customerId: "customer-1",
        packageId: "package-1",
        soldInvoiceId: null,
        staffId: "staff-001"
      }
    })).not.toThrow();

    expect(() => schemas.packageRedeem.parse({
      body: {
        customerPackageId: "customer-package-1",
        serviceId: "service-1",
        sessionsUsed: 1,
        invoiceId: null
      }
    })).not.toThrow();
  });

  it("still allows assignment payloads without staffId when owner flow omits it", () => {
    expect(() => schemas.assignMembership.parse({
      body: {
        customerId: "customer-1",
        membershipPlanId: "membership-plan-1",
        soldInvoiceId: null
      }
    })).not.toThrow();

    expect(() => schemas.assignPackage.parse({
      body: {
        customerId: "customer-1",
        packageId: "package-1",
        soldInvoiceId: null
      }
    })).not.toThrow();
  });
});
