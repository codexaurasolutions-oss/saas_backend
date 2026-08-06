import { prisma } from "../../../lib/prisma.js";
import { requireFeatureEnabled, requireSalonPermission } from "../../../middlewares/rbac.js";

export const registerStaffRequirementRoutes = (ownerRouter) => {
  ownerRouter.get("/staff-requirements", requireFeatureEnabled("staffManagement"), requireSalonPermission("staffManagement", "view"), async (req, res) => {
    const requirements = await prisma.staffRequirement.findMany({
      where: { salonId: req.salonId },
      orderBy: { createdAt: "desc" }
    });
    res.json(requirements);
  });

  ownerRouter.post("/staff-requirements", requireFeatureEnabled("staffManagement"), requireSalonPermission("staffManagement", "create"), async (req, res) => {
    const { title, description, department, position, salary, shift, urgency, skills, count, priority } = req.body;
    if (!title || !String(title).trim()) {
      return res.status(400).json({ message: "Title is required" });
    }
    const requirement = await prisma.staffRequirement.create({
      data: {
        salonId: req.salonId,
        title: String(title).trim(),
        description: description || null,
        department: department || null,
        position: position || null,
        salary: salary || null,
        shift: shift || null,
        urgency: urgency || "MEDIUM",
        skills: skills || null,
        count: count ? parseInt(count) : 1,
        priority: priority || "MEDIUM",
        status: "OPEN"
      }
    });
    res.status(201).json(requirement);
  });

  ownerRouter.delete("/staff-requirements/:id", requireFeatureEnabled("staffManagement"), requireSalonPermission("staffManagement", "edit"), async (req, res) => {
    const requirement = await prisma.staffRequirement.findFirst({
      where: { id: req.params.id, salonId: req.salonId }
    });
    if (!requirement) return res.status(404).json({ message: "Requirement not found" });
    await prisma.staffRequirement.delete({ where: { id: requirement.id } });
    res.json({ message: "Requirement deleted" });
  });
};
