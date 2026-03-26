/**
 * Zabbix API type definitions.
 *
 * These types will be expanded as the Zabbix integration is built out.
 * For now they serve as documentation of the data structures we expect.
 */

/** Zabbix host object (simplified) */
export interface ZabbixHost {
  hostid: string;
  host: string;
  name: string;
  status: number; // 0 = monitored, 1 = unmonitored
}

/** Zabbix problem object (simplified) */
export interface ZabbixProblem {
  eventid: string;
  objectid: string;
  name: string;
  severity: number; // 0-5: not classified, information, warning, average, high, disaster
  clock: string; // unix timestamp
  r_eventid: string; // recovery event ID (empty if unresolved)
}

/** Zabbix event object (simplified) */
export interface ZabbixEvent {
  eventid: string;
  source: number;
  object: number;
  objectid: string;
  clock: string;
  name: string;
  severity: number;
}

/** Zabbix trigger object (simplified) */
export interface ZabbixTrigger {
  triggerid: string;
  description: string;
  priority: number;
  status: number;
  value: number; // 0 = OK, 1 = PROBLEM
}
