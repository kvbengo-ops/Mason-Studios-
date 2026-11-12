import { dateTimeFormatter } from "@/lib/datetime";
import { formatUsd } from "@/lib/format-usd";

// The studio-light theme (config/themes/studio-light.css), as hex: mail clients
// read neither CSS variables nor hsl() reliably, and web fonts barely at all,
// so the serif/sans pairing falls back to stacks every client has.
const INK = "#13192A";
const MUTED = "#5E6778";
const BORDER = "#D7DCE5";
const PAGE = "#F8F9FC";
const PRIMARY = "#2073B6";
const WARNING = "#A54312";
const WARNING_TINT = "#FDF1EA";
const SERIF = "'Source Serif 4', Georgia, 'Times New Roman', serif";
const SANS = "'Inter Tight', -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

export interface BalanceAlertEmailInput {
  vendorLabel: string;
  balanceUsd: number;
  thresholdUsd: number;
  appUrl: string;
  sentAt: Date;
}

/**
 * The low-balance alert (lib/balance-alert.ts), as a Maison Studios email:
 * table layout and inline styles only, a hidden preheader for the inbox
 * preview, and a plain-text twin for clients that show no HTML. Every value
 * interpolated is a formatted number, a fixed vendor name or our own URL, so
 * nothing here needs HTML escaping.
 */
export function buildBalanceAlertEmail(input: BalanceAlertEmailInput): {
  subject: string;
  html: string;
  text: string;
} {
  const { vendorLabel, balanceUsd, thresholdUsd, sentAt } = input;
  const appUrl = input.appUrl.replace(/\/+$/, "");
  const balance = formatUsd(balanceUsd);
  const threshold = formatUsd(thresholdUsd);
  const short = formatUsd(Math.max(0, thresholdUsd - balanceUsd));
  const when = dateTimeFormatter.format(sentAt);
  const dashboard = `${appUrl}/accounts-control`;
  const preheader = `${vendorLabel} is at ${balance}, ${short} under your ${threshold} alert.`;

  const subject = `${vendorLabel} balance is low: ${balance}`;

  const text = [
    `Low balance alert — ${vendorLabel}`,
    ``,
    `${vendorLabel} is at ${balance}, ${short} under your alert threshold of ${threshold}.`,
    `Top it up before renders on ${vendorLabel} start failing.`,
    ``,
    `Open Accounts Control: ${dashboard}`,
    ``,
    `Checked ${when}. You get one email per drop; it re-arms once the balance is back above ${threshold}.`,
    `Change the threshold or who is emailed under Balance alerts in Accounts Control.`,
    ``,
    `Maison Studios`,
  ].join("\n");

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${subject}</title>
</head>
<body style="margin:0;padding:0;background:${PAGE};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${PAGE};">${preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PAGE};">
  <tr>
    <td align="center" style="padding:40px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
        <tr>
          <td style="padding:0 4px 20px 4px;">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="vertical-align:middle;padding-right:10px;">
                  <img src="${appUrl}/maison-cosmetics-logo.jpg" width="32" height="30" alt="Maison" style="display:block;border:0;border-radius:6px;">
                </td>
                <td style="vertical-align:middle;font-family:${SERIF};font-size:18px;font-weight:600;color:${INK};letter-spacing:-0.2px;">
                  Maison Studios
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="background:#FFFFFF;border:1px solid ${BORDER};border-radius:14px;overflow:hidden;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr><td style="height:4px;background:${WARNING};font-size:0;line-height:0;">&nbsp;</td></tr>
              <tr>
                <td style="padding:32px 32px 8px 32px;font-family:${SANS};">
                  <span style="display:inline-block;padding:4px 10px;border-radius:999px;background:${WARNING_TINT};color:${WARNING};font-size:12px;font-weight:600;letter-spacing:0.2px;">
                    Low balance alert
                  </span>
                  <h1 style="margin:16px 0 8px 0;font-family:${SERIF};font-size:26px;line-height:1.25;font-weight:600;color:${INK};">
                    ${vendorLabel} is running low
                  </h1>
                  <p style="margin:0;font-size:15px;line-height:1.6;color:${MUTED};">
                    The ${vendorLabel} balance dropped below the alert level you set. Top it up
                    before renders on ${vendorLabel} start failing.
                  </p>
                </td>
              </tr>
              <tr>
                <td style="padding:24px 32px;">
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid ${BORDER};border-radius:12px;">
                    <tr>
                      <td width="50%" style="padding:18px 20px;font-family:${SANS};border-right:1px solid ${BORDER};">
                        <div style="font-size:12px;color:${MUTED};text-transform:uppercase;letter-spacing:0.6px;">Current balance</div>
                        <div style="margin-top:6px;font-size:28px;font-weight:700;color:${WARNING};letter-spacing:-0.5px;">${balance}</div>
                      </td>
                      <td width="50%" style="padding:18px 20px;font-family:${SANS};">
                        <div style="font-size:12px;color:${MUTED};text-transform:uppercase;letter-spacing:0.6px;">Alert threshold</div>
                        <div style="margin-top:6px;font-size:28px;font-weight:700;color:${INK};letter-spacing:-0.5px;">${threshold}</div>
                      </td>
                    </tr>
                    <tr>
                      <td colspan="2" style="padding:12px 20px;background:${PAGE};border-top:1px solid ${BORDER};border-radius:0 0 12px 12px;font-family:${SANS};font-size:13px;color:${MUTED};">
                        <strong style="color:${INK};">${short}</strong> under your alert level
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
              <tr>
                <td style="padding:0 32px 32px 32px;font-family:${SANS};">
                  <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                    <tr>
                      <td style="border-radius:10px;background:${PRIMARY};">
                        <a href="${dashboard}" style="display:inline-block;padding:12px 22px;font-family:${SANS};font-size:15px;font-weight:600;color:#FFFFFF;text-decoration:none;border-radius:10px;">
                          Open Accounts Control &rarr;
                        </a>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td style="padding:20px 8px 0 8px;font-family:${SANS};font-size:12px;line-height:1.6;color:${MUTED};">
            Checked ${when}. You get one email per drop; it re-arms once the balance is back
            above ${threshold}. Change the threshold or who is emailed under
            <a href="${dashboard}" style="color:${PRIMARY};text-decoration:underline;">Balance alerts</a>
            in Accounts Control.
            <br><br>
            Maison Studios
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;

  return { subject, html, text };
}
