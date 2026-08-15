import assert from 'node:assert/strict';
import { computeRegionalCtPlan } from './src/data/migrations.ts';
const counties = ['Fairfield','Hartford','Litchfield','Middlesex','New Haven','New London','Tolland','Windham'].map((name,i)=>({id:`c${i}`,name,zip_codes:(name==='New Haven'?['10002']:name==='Fairfield'?['10000','10001','10003']:Array.from({length:3},(_,j)=>String(10000+i*10+j)))}));
// Fixture uses disjoint county ZIPs and exact byte names, including en-dashes.
const existing=[{id:'sw',name:'Southwest CT',zip_codes:['10000']},{id:'bm',name:'Bridgeport–Milford',zip_codes:['10001']},{id:'nh',name:'New Haven–Branford',zip_codes:['10002']}];
const p=computeRegionalCtPlan(existing,counties); assert.equal(p.regions.length,9); assert.equal(p.duplicates.length,0); assert.equal(p.gaps.length,0); assert.ok(p.regions.every(r=>r.name!=='CT')); assert.deepEqual(p.regions.slice(0,3).map(r=>r.id),['sw','bm','nh']); assert.equal(p.regions.find(r=>r.name==='Greater Danbury/Waterbury').parentName,'Litchfield'); console.log('PASS migration 57 partition fixture');
