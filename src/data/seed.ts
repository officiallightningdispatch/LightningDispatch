export type ContractorStatus = "online" | "offline";
export type JobStatus =
  | "new"
  | "offered"
  | "accepted"
  | "en_route"
  | "arrived"
  | "completed"
  | "cancelled";
export type ServiceType =
  | "jump_start"
  | "tire_change"
  | "lockout"
  | "flatbed_tow"
  | "fuel_delivery"
  | "battery_install";

export interface Location {
  lat: number;
  lng: number;
  area: string;
}

export interface Contractor {
  id: string;
  name: string;
  status: ContractorStatus;
  location: Location;
  vehicleTypes: string[];
  rating: number;
  completedJobCount: number;
  responseTimeHistoryMinutes: number[];
}

export interface Job {
  id: string;
  /** Towbook job number for owner-facing notifications. */
  towbookJobId?: string;
  customerName: string;
  phone: string;
  location: Location;
  serviceType: ServiceType;
  status: JobStatus;
  createdAt: string;
  assignedAt?: string;
  arrivedAt?: string;
  completedAt?: string;
  assignedContractorId?: string;
  /** Assigned driver captured from the Towbook call (assets[].driver) at sync
   *  time — the REAL assignment the AI dispatcher / Towbook made. Populated for
   *  synced jobs; legacy manual assigns use assignedContractorId instead. */
  assignedDriverName?: string;
  assignedDriverTowbookId?: string;
  note: string;
}

export const contractors: Contractor[] = [
  { id: "con-001", name: "Marcus Johnson", status: "online", location: { lat: 33.749, lng: -84.388, area: "Downtown Atlanta" }, vehicleTypes: ["jump-start equipped", "tire service"], rating: 4.9, completedJobCount: 284, responseTimeHistoryMinutes: [8, 11, 9, 14, 7] },
  { id: "con-002", name: "Elena Rodriguez", status: "online", location: { lat: 33.776, lng: -84.365, area: "Old Fourth Ward" }, vehicleTypes: ["flatbed", "jump-start equipped"], rating: 4.8, completedJobCount: 197, responseTimeHistoryMinutes: [12, 10, 15, 9, 11] },
  { id: "con-003", name: "Darius Williams", status: "online", location: { lat: 33.819, lng: -84.368, area: "Buckhead" }, vehicleTypes: ["flatbed", "tire service", "fuel delivery"], rating: 4.7, completedJobCount: 163, responseTimeHistoryMinutes: [16, 13, 18, 14, 12] },
  { id: "con-004", name: "Sam Patel", status: "offline", location: { lat: 33.703, lng: -84.44, area: "East Point" }, vehicleTypes: ["jump-start equipped", "lockout tools"], rating: 4.6, completedJobCount: 121, responseTimeHistoryMinutes: [10, 8, 12, 13, 9] },
  { id: "con-005", name: "Tasha Green", status: "offline", location: { lat: 33.913, lng: -84.378, area: "Sandy Springs" }, vehicleTypes: ["flatbed"], rating: 4.9, completedJobCount: 246, responseTimeHistoryMinutes: [14, 12, 11, 16, 13] },
];

export const jobs: Job[] = [
  { id: "job-1042", customerName: "Nina Thompson", phone: "(404) 555-0142", location: { lat: 33.755, lng: -84.39, area: "Castleberry Hill" }, serviceType: "jump_start", status: "new", createdAt: "2026-08-06T14:18:00Z", note: "2019 Honda Accord; battery completely dead." },
  { id: "job-1041", customerName: "Robert Chen", phone: "(404) 555-0198", location: { lat: 33.801, lng: -84.39, area: "Atlantic Station" }, serviceType: "flatbed_tow", status: "new", createdAt: "2026-08-06T14:05:00Z", note: "Vehicle will not start after minor collision." },
  { id: "job-1040", customerName: "Keisha Brown", phone: "(470) 555-0107", location: { lat: 33.771, lng: -84.351, area: "Poncey-Highland" }, serviceType: "tire_change", status: "offered", createdAt: "2026-08-06T13:42:00Z", assignedAt: "2026-08-06T13:45:00Z", assignedContractorId: "con-001", note: "Rear passenger tire is flat; spare is in trunk." },
  { id: "job-1039", customerName: "James Wilson", phone: "(404) 555-0166", location: { lat: 33.84, lng: -84.377, area: "Lenox" }, serviceType: "lockout", status: "en_route", createdAt: "2026-08-06T13:08:00Z", assignedAt: "2026-08-06T13:12:00Z", assignedContractorId: "con-003", note: "Keys locked in 2022 Toyota Camry." },
  { id: "job-1038", customerName: "Avery Morgan", phone: "(678) 555-0133", location: { lat: 33.735, lng: -84.414, area: "West End" }, serviceType: "fuel_delivery", status: "completed", createdAt: "2026-08-06T11:22:00Z", assignedAt: "2026-08-06T11:25:00Z", arrivedAt: "2026-08-06T11:43:00Z", completedAt: "2026-08-06T11:55:00Z", assignedContractorId: "con-002", note: "Out of regular unleaded; delivered 2 gallons." },
];

export const dispatchSeed = { contractors, jobs } as const;
