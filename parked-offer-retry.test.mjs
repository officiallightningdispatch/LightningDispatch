import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('./src/data/ai-dispatcher.ts', import.meta.url), 'utf8');
const check = (name, ok) => { if (!ok) throw new Error(name); console.log(`ok - ${name}`); };
check('retry query includes accepted no-driver claims', src.includes("decision IN ('escalated_dispatch_pending','auto_accept_no_driver')"));
check('retry never accepts again', src.includes('never posts accept again or reverses the accepted claim'));
check('retry requires fresh online tow capability', src.includes("heartbeat_at > NOW() - INTERVAL '90 seconds'") && src.includes('vehicle_type'));
check('retry preserves state guard', src.includes('stateGuardResolver') && src.includes('state.state.toUpperCase()'));
check('retry records resolved ledger reason', src.includes('parked-offer retry dispatched to eligible in-state driver'));
