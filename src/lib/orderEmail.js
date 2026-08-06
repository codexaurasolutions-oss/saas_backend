import { sendMail } from "./mailer.js";
import { prisma } from "./prisma.js";
import { attemptCustomerTemplateWhatsApp } from "./emailNotifications.js";

/**
 * Builds a beautiful HTML email for order confirmation.
 */
const buildOrderConfirmationHtml = ({ order, salon, siteUrl }) => {
  const currency = salon.currency || "INR";
  const accentColor = "#c8a97e";

  const itemsHtml = (order.items || []).map((item) => {
    const price = item.unitPrice ?? item.lineTotal ?? 0;
    return `
      <tr>
        <td style="padding:12px 0;border-bottom:1px solid #f1f5f9;color:#374151;font-size:14px;">
          ${item.productName || item.name || "Product"}
        </td>
        <td style="padding:12px 0;border-bottom:1px solid #f1f5f9;text-align:center;color:#6b7280;font-size:14px;">
          x${item.qty}
        </td>
        <td style="padding:12px 0;border-bottom:1px solid #f1f5f9;text-align:right;font-weight:600;color:#111827;font-size:14px;">
          ${currency} ${Number(price).toFixed(2)}
        </td>
      </tr>`;
  }).join("");

  const subtotal = (order.items || []).reduce((s, i) => s + Number(i.unitPrice || 0) * Number(i.qty || 1), 0);
  const taxAmount = Number(order.tax || 0);
  const deliveryFee = Number(order.deliveryFee || 0);
  const total = Number(order.total || 0);

  const paymentBadge = {
    PAY_AT_SALON: { text: "Pay at Salon", color: "#f59e0b" },
    COD: { text: "Cash on Delivery", color: "#f59e0b" },
    ONLINE: { text: "Paid Online", color: "#10b981" },
  }[order.paymentMode] || { text: order.paymentMode || "Pending", color: "#6b7280" };

  const fulfillmentText = order.fulfillmentMethod === "DELIVERY" ? "Delivery" : "Pickup";
  const orderDate = order.createdAt ? new Date(order.createdAt).toLocaleString("en-PK", { dateStyle: "long", timeStyle: "short" }) : "";
  const trackUrl = siteUrl ? `${siteUrl}/site/${salon.slug}/my-orders` : "";

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Order Confirmed – ${order.orderNumber}</title>
</head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

          <!-- HEADER -->
          <tr>
            <td style="background:linear-gradient(135deg,#111827 0%,#1f2937 50%,#374151 100%);padding:40px 40px 32px;border-radius:16px 16px 0 0;text-align:center;">
              <h1 style="margin:0 0 4px;font-size:28px;font-weight:800;color:#ffffff;letter-spacing:-0.5px;">
                ${salon.name || "Your Salon"}
              </h1>
              <p style="margin:0;font-size:13px;color:#c8a97e;letter-spacing:1px;text-transform:uppercase;">Order Confirmation</p>
            </td>
          </tr>

          <!-- GREEN CHECK BANNER -->
          <tr>
            <td style="background:${accentColor};padding:24px 40px;text-align:center;">
              <div style="display:inline-block;background:rgba(255,255,255,0.2);border-radius:50%;width:48px;height:48px;line-height:48px;font-size:24px;margin-bottom:8px;">✓</div>
              <h2 style="margin:8px 0 4px;font-size:22px;color:#ffffff;font-weight:700;">Order Confirmed!</h2>
              <p style="margin:0;font-size:14px;color:rgba(255,255,255,0.85);">
                Your order <strong>#${order.orderNumber}</strong> has been received successfully.
              </p>
            </td>
          </tr>

          <!-- MAIN CONTENT -->
          <tr>
            <td style="background:#ffffff;padding:32px 40px;">

              <!-- Customer Greeting -->
              <p style="margin:0 0 24px;font-size:16px;color:#374151;">
                Hi <strong>${order.customerName || "Valued Customer"}</strong>, thank you for your order!
              </p>

              <!-- Order Meta Info -->
              <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9fafb;border-radius:12px;padding:20px;margin-bottom:28px;">
                <tr>
                  <td style="padding:6px 0;">
                    <table width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="font-size:13px;color:#6b7280;width:50%;padding:4px 0;">Order Number</td>
                        <td style="font-size:13px;color:#111827;font-weight:700;text-align:right;padding:4px 0;">${order.orderNumber}</td>
                      </tr>
                      <tr>
                        <td style="font-size:13px;color:#6b7280;padding:4px 0;">Order Date</td>
                        <td style="font-size:13px;color:#111827;text-align:right;padding:4px 0;">${orderDate}</td>
                      </tr>
                      <tr>
                        <td style="font-size:13px;color:#6b7280;padding:4px 0;">Fulfillment</td>
                        <td style="font-size:13px;color:#111827;text-align:right;padding:4px 0;">${fulfillmentText}</td>
                      </tr>
                      <tr>
                        <td style="font-size:13px;color:#6b7280;padding:4px 0;">Payment</td>
                        <td style="text-align:right;padding:4px 0;">
                          <span style="background:${paymentBadge.color}22;color:${paymentBadge.color};padding:2px 10px;border-radius:100px;font-size:12px;font-weight:600;">${paymentBadge.text}</span>
                        </td>
                      </tr>
                      ${order.deliveryAddress ? `
                      <tr>
                        <td style="font-size:13px;color:#6b7280;padding:4px 0;vertical-align:top;">Delivery Address</td>
                        <td style="font-size:13px;color:#111827;text-align:right;padding:4px 0;">${order.deliveryAddress}</td>
                      </tr>` : ""}
                    </table>
                  </td>
                </tr>
              </table>

              <!-- Order Items -->
              <h3 style="margin:0 0 16px;font-size:15px;font-weight:700;color:#111827;border-bottom:2px solid ${accentColor};padding-bottom:8px;">
                Items Ordered
              </h3>
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <th style="text-align:left;font-size:12px;color:#9ca3af;font-weight:600;padding-bottom:8px;text-transform:uppercase;letter-spacing:0.5px;">Product</th>
                  <th style="text-align:center;font-size:12px;color:#9ca3af;font-weight:600;padding-bottom:8px;text-transform:uppercase;letter-spacing:0.5px;">Qty</th>
                  <th style="text-align:right;font-size:12px;color:#9ca3af;font-weight:600;padding-bottom:8px;text-transform:uppercase;letter-spacing:0.5px;">Price</th>
                </tr>
                ${itemsHtml}
              </table>

              <!-- Totals -->
              <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:20px;">
                ${subtotal !== total ? `
                <tr>
                  <td style="font-size:13px;color:#6b7280;padding:4px 0;">Subtotal</td>
                  <td style="font-size:13px;color:#374151;text-align:right;padding:4px 0;">${currency} ${subtotal.toFixed(2)}</td>
                </tr>` : ""}
                ${taxAmount > 0 ? `
                <tr>
                  <td style="font-size:13px;color:#6b7280;padding:4px 0;">Tax</td>
                  <td style="font-size:13px;color:#374151;text-align:right;padding:4px 0;">${currency} ${taxAmount.toFixed(2)}</td>
                </tr>` : ""}
                ${deliveryFee > 0 ? `
                <tr>
                  <td style="font-size:13px;color:#6b7280;padding:4px 0;">Delivery Fee</td>
                  <td style="font-size:13px;color:#374151;text-align:right;padding:4px 0;">${currency} ${deliveryFee.toFixed(2)}</td>
                </tr>` : ""}
                <tr>
                  <td style="font-size:17px;font-weight:800;color:#111827;padding-top:12px;border-top:2px solid #f1f5f9;">Total</td>
                  <td style="font-size:17px;font-weight:800;color:${accentColor};text-align:right;padding-top:12px;border-top:2px solid #f1f5f9;">${currency} ${total.toFixed(2)}</td>
                </tr>
              </table>

              <!-- What's Next -->
              <div style="background:#faf6f0;border-radius:12px;padding:20px;margin-top:28px;border-left:4px solid #c8a97e;">
                <p style="margin:0 0 8px;font-size:14px;font-weight:700;color:#92400e;">What happens next?</p>
                <ul style="margin:0;padding-left:20px;color:#374151;font-size:13px;line-height:2;">
                  <li>Our team will review and confirm your order shortly.</li>
                  <li>You'll receive updates as your order progresses.</li>
                  ${order.paymentMode === "PAY_AT_SALON" || order.paymentMode === "COD"
                    ? "<li>Please have your payment ready when you pick up / receive your order.</li>"
                    : "<li>Your online payment has been received — no further action needed.</li>"}
                </ul>
              </div>

              ${trackUrl ? `
              <!-- CTA Button -->
              <div style="text-align:center;margin-top:32px;">
                <a href="${trackUrl}" style="display:inline-block;background:${accentColor};color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:10px;font-size:15px;font-weight:700;letter-spacing:0.3px;">
                  Track My Orders →
                </a>
              </div>` : ""}

            </td>
          </tr>

          <!-- FOOTER -->
          <tr>
            <td style="background:#111827;padding:24px 40px;border-radius:0 0 16px 16px;text-align:center;">
              <p style="margin:0 0 8px;font-size:15px;font-weight:700;color:#ffffff;">${salon.name || "Your Salon"}</p>
              ${salon.phone ? `<p style="margin:0 0 4px;font-size:13px;color:#9ca3af;">${salon.phone}</p>` : ""}
              ${salon.email ? `<p style="margin:0 0 4px;font-size:13px;color:#9ca3af;">${salon.email}</p>` : ""}
              ${salon.address ? `<p style="margin:0 0 12px;font-size:13px;color:#9ca3af;">${salon.address}</p>` : ""}
              <p style="margin:0;font-size:11px;color:#4b5563;">
                This is an automated confirmation email. Please do not reply directly to this email.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
};

/**
 * Send a rich HTML order confirmation email to the customer.
 * Safe to call — silently logs errors without crashing the order flow.
 */
export const sendOrderConfirmationEmail = async ({ order, salonId }) => {
  if (!order?.customerEmail) {
    console.log(`[orderEmail] Skipped — no customer email on order ${order?.orderNumber}`);
    return { skipped: true, reason: "no-email" };
  }

  try {
    const salon = await prisma.salon.findUnique({ where: { id: salonId } });
    if (!salon) return { skipped: true, reason: "salon-not-found" };

    const siteUrl = process.env.FRONTEND_APP_URL || "http://localhost:5173";
    const html = buildOrderConfirmationHtml({ order, salon, siteUrl });

    const result = await sendMail({
      to: order.customerEmail,
      subject: `Order Confirmed - #${order.orderNumber} | ${salon.name}`,
      html,
    });

    if (order.customerPhone) {
      await attemptCustomerTemplateWhatsApp({
        salonId,
        toPhone: order.customerPhone,
        templateType: "order_confirmation",
        context: { orderId: order.id, customerId: order.customerId, orderNumber: order.orderNumber },
        customerId: order.customerId
      }).catch(() => {});
    }

    console.log(`[orderEmail] Confirmation sent to ${order.customerEmail} for order ${order.orderNumber}`);
    return { sent: true, ...result };
  } catch (err) {
    console.error(`[orderEmail] Failed to send confirmation for order ${order?.orderNumber}:`, err.message);
    return { skipped: true, reason: "delivery-error", error: err.message };
  }
};
