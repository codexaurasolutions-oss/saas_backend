import { prisma } from "./prisma.js";

export const getCreditCosts = async () => {
  const globalSetting = await prisma.globalSetting.findFirst();
  const defaults = globalSetting?.notificationDefaults || {};
  return {
    whatsapp: defaults.whatsappCreditCost !== undefined ? Number(defaults.whatsappCreditCost) : 1,
    sms: defaults.smsCreditCost !== undefined ? Number(defaults.smsCreditCost) : 1
  };
};

export const getCreditsBalance = async (salonId) => {
  const salon = await prisma.salon.findUnique({ where: { id: salonId }, select: { credits: true } });
  return salon?.credits || 0;
};

export const deductCredits = async (salonId, type = "whatsapp") => {
  const costs = await getCreditCosts();
  const cost = costs[type] || 1;

  const salon = await prisma.salon.findUnique({ where: { id: salonId }, select: { credits: true } });
  const current = salon?.credits || 0;

  if (current < cost) {
    return { success: false, remaining: current, cost, reason: "insufficient-credits" };
  }

  await prisma.salon.update({ where: { id: salonId }, data: { credits: { decrement: cost } } });
  return { success: true, remaining: current - cost, cost };
};

export const addCredits = async (salonId, amount) => {
  if (!Number.isFinite(amount) || amount <= 0) return false;
  await prisma.salon.update({ where: { id: salonId }, data: { credits: { increment: amount } } });
  return true;
};

export const hasEnoughCredits = async (salonId, type = "whatsapp") => {
  const costs = await getCreditCosts();
  const cost = costs[type] || 1;
  const balance = await getCreditsBalance(salonId);
  return balance >= cost;
};
