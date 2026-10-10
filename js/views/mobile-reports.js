import {el} from '../util.js';
import {topbar,go} from '../app.js';
import {icon} from '../icons.js';
let host=null;
const links=[['expense','Expense report','Categories and spending details','spend'],['income','Income report','Sources and earnings','earn'],['incexp','Income vs expense','Monthly and yearly trends','scales'],['statement','Account statement','Balances and transaction history','receipt'],['networth','Net worth & assets','Savings, investments and property','bank'],['business','Business P&L','Business income and costs','bars'],['equity','Equity portfolio','Holdings and performance','trendUp']];
export async function render(root){host=root;draw();}
export function refresh(){if(host?.isConnected)draw();}
function draw(){host.innerHTML='';host.append(topbar('Reports'));host.append(el('p',{class:'muted small'},'Your details, one tap away.'));
const list=el('div',{class:'jf-mobile-report-list'});for(const [route,title,sub,mark] of links)list.append(el('button',{class:'jf-report-link',onclick:()=>go(route)},el('span',{class:'jf-report-icon'},icon(mark,20)),el('span',{class:'jf-report-copy'},el('b',{},title),el('small',{},sub)),el('span',{class:'muted'},'›')));host.append(list);}
