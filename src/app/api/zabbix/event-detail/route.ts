import { getZabbixClient } from "@/lib/zabbix/client";
import { NextResponse } from "next/server";

export async function GET() {
  const client = getZabbixClient();

  try {
    // Get events with ALL possible detail fields
    const eventsDetailed = await client.request("event.get", {
      output: "extend",
      selectTags: "extend",
      selectAcknowledges: "extend",
      selectSuppressionData: "extend",
      selectHosts: ["hostid", "host", "name"],
      sortfield: ["clock"],
      sortorder: "DESC",
      limit: 10,
    });

    // Get triggers with full details
    const triggersDetailed = await client.request("trigger.get", {
      output: ["triggerid", "description", "priority", "lastchange", "value", "status", "comments", "url", "expression", "opdata", "event_name"],
      selectHosts: ["hostid", "host", "name"],
      selectItems: ["itemid", "name", "key_", "lastvalue", "units", "description"],
      selectFunctions: "extend",
      selectDependencies: ["triggerid", "description"],
      expandDescription: true,
      expandComment: true,
      expandExpression: true,
      limit: 10,
    });

    // Try to get alerts (might be denied)
    let alerts = null;
    try {
      alerts = await client.request("alert.get", {
        output: "extend",
        sortfield: "clock",
        sortorder: "DESC",
        limit: 5,
      });
    } catch (e) {
      alerts = `No access: ${e}`;
    }

    // Try to get audit log
    let auditlog = null;
    try {
      auditlog = await client.request("auditlog.get", {
        output: "extend",
        sortfield: "clock",
        sortorder: "DESC",
        limit: 5,
      });
    } catch (e) {
      auditlog = `No access: ${e}`;
    }

    return NextResponse.json({
      eventsDetailed,
      triggersDetailed,
      alerts,
      auditlog,
    }, { status: 200 });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
