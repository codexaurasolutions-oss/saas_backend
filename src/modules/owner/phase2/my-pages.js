import { prisma } from "../../../lib/prisma.js";
import { toAmount } from "../../../lib/phase2.js";
import { requireSalonPermission } from "../../../middlewares/rbac.js";

export const registerMyPageRoutes = (ownerRouter) => {
  ownerRouter.get("/my-dashboard", requireSalonPermission("myDashboard", "view"), async (req, res) => {
    const [profile, scopedAppointments, notifications] = await Promise.all([
      prisma.userSalon.findFirst({
        where: { id: req.user.membershipId, salonId: req.salonId },
        include: { serviceAssignments: { include: { service: { include: { category: true } } } } }
      }),
      prisma.appointment.findMany({
        where: {
          salonId: req.salonId,
          items: { some: { assignedStaff: { some: { userSalonId: req.user.membershipId } } } }
        },
        include: { customer: true },
        orderBy: { startAt: "desc" },
        take: 10
      }),
      prisma.appointmentLog.findMany({
        where: {
          appointment: {
            salonId: req.salonId,
            items: { some: { assignedStaff: { some: { userSalonId: req.user.membershipId } } } }
          }
        },
        include: { appointment: { include: { customer: true, branch: true } } },
        orderBy: { createdAt: "desc" },
        take: 8
      })
    ]);
    res.json({
      todayAppointments: scopedAppointments.filter((item) => new Date(item.startAt).toDateString() === new Date().toDateString()),
      recentAppointments: scopedAppointments.slice(0, 5),
      assignedServices: profile?.serviceAssignments || [],
      notifications
    });
  });

  ownerRouter.get("/my-notifications", requireSalonPermission("myDashboard", "view"), async (req, res) => {
    res.json(await prisma.appointmentLog.findMany({
      where: {
        appointment: {
          salonId: req.salonId,
          items: { some: { assignedStaff: { some: { userSalonId: req.user.membershipId } } } }
        }
      },
      include: { appointment: { include: { customer: true, branch: true } } },
      orderBy: { createdAt: "desc" },
      take: 15
    }));
  });

  ownerRouter.get("/my-appointments", requireSalonPermission("myAppointments", "view"), async (req, res) => {
    res.json(await prisma.appointment.findMany({
      where: {
        salonId: req.salonId,
        items: { some: { assignedStaff: { some: { userSalonId: req.user.membershipId } } } }
      },
      include: { customer: true, branch: true, items: { include: { service: { include: { category: true } } } } },
      orderBy: { startAt: "asc" }
    }));
  });

  ownerRouter.get("/my-schedule", requireSalonPermission("mySchedule", "view"), async (req, res) => {
    res.json({
      schedules: await prisma.staffSchedule.findMany({ where: { userSalonId: req.user.membershipId }, orderBy: { weekday: "asc" } }),
      breaks: await prisma.staffBreak.findMany({ where: { userSalonId: req.user.membershipId }, orderBy: [{ weekday: "asc" }, { startTime: "asc" }] })
    });
  });

  ownerRouter.get("/my-commission", requireSalonPermission("myCommission", "view"), async (req, res) => {
    const ownItems = await prisma.invoiceItem.findMany({
      where: {
        invoice: { salonId: req.salonId, status: { in: ["PAID", "PARTIAL"] } },
        staffUserSalonId: req.user.membershipId
      },
      include: { invoice: { include: { customer: true, branch: true } } },
      orderBy: { invoice: { createdAt: "desc" } }
    });
    res.json({
      totalCommission: ownItems.reduce((sum, item) => sum + toAmount(item.commissionAmount), 0),
      itemCount: ownItems.length,
      items: ownItems
    });
  });

  ownerRouter.get("/my-payroll", requireSalonPermission("myPayroll", "view"), async (req, res) => {
    const items = await prisma.payrollItem.findMany({
      where: {
        salonId: req.salonId,
        userSalonId: req.user.membershipId
      },
      include: {
        payrollRun: {
          include: {
            branch: true,
            generatedByMembership: {
              include: { user: true }
            }
          }
        },
        userSalon: {
          include: {
            user: true,
            branch: true
          }
        }
      },
      orderBy: [
        { payrollRun: { periodStart: "desc" } },
        { createdAt: "desc" }
      ]
    });

    const summary = items.reduce((accumulator, item) => {
      accumulator.itemCount += 1;
      accumulator.totalBaseSalary += toAmount(item.baseSalary);
      accumulator.totalCommission += toAmount(item.commissionAmount);
      accumulator.totalIncentive += toAmount(item.incentiveAmount);
      accumulator.totalAdjustments += toAmount(item.adjustmentAmount);
      accumulator.totalDeductions += toAmount(item.attendanceDeduction) + toAmount(item.leaveDeduction);
      accumulator.totalNet += toAmount(item.netAmount);
      return accumulator;
    }, {
      itemCount: 0,
      totalBaseSalary: 0,
      totalCommission: 0,
      totalIncentive: 0,
      totalAdjustments: 0,
      totalDeductions: 0,
      totalNet: 0
    });

    res.json({ summary, items });
  });

  ownerRouter.get("/my-profile", requireSalonPermission("myProfile", "view"), async (req, res) => {
    const profile = await prisma.userSalon.findFirst({
      where: { id: req.user.membershipId, salonId: req.salonId },
      include: { user: true, branch: true, serviceAssignments: { include: { service: { include: { category: true } } } } }
    });
    res.json(profile);
  });

  ownerRouter.patch("/my-profile", requireSalonPermission("myProfile", "edit"), async (req, res) => {
    const profile = await prisma.userSalon.findFirst({ where: { id: req.user.membershipId, salonId: req.salonId } });
    if (!profile) return res.status(404).json({ message: "Profile not found" });
    res.json(await prisma.userSalon.update({
      where: { id: profile.id },
      data: {
        phone: req.body.phone ?? profile.phone,
        profileNote: req.body.profileNote ?? profile.profileNote,
        avatarUrl: req.body.avatarUrl ?? profile.avatarUrl
      }
    }));
  });
};
