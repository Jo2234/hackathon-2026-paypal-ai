import type { Db } from '../db/db.ts';
import { all, int, reservation, text } from '../db/repo.ts';
import { formatMinor } from '../../domain/money.ts';
export function createOrderBody(db:Db,id:string,merchantId:string,callbacks?:{returnUrl:string;cancelUrl:string}):unknown {
  const r=reservation(db,id);
  const lines=all(db,'SELECT * FROM reservation_lines WHERE reservation_id=? ORDER BY sku',id);
  const itemTotal=lines.reduce((sum,l)=>sum+int(l,'line_minor'),0);
  if(!Number.isSafeInteger(itemTotal) || itemTotal+500!==r.amount) throw new Error('ORDER_SNAPSHOT_MISMATCH');
  return {...(callbacks?{payment_source:{paypal:{experience_context:{return_url:callbacks.returnUrl,cancel_url:callbacks.cancelUrl,user_action:'PAY_NOW'}}}}:{}),intent:'CAPTURE',purchase_units:[{custom_id:r.id,invoice_id:r.id,payee:{merchant_id:merchantId},amount:{currency_code:'USD',value:formatMinor(r.amount,'USD'),breakdown:{item_total:{currency_code:'USD',value:formatMinor(itemTotal,'USD')},shipping:{currency_code:'USD',value:'5.00'}}},items:lines.map(l=>({name:text(l,'sku'),sku:text(l,'sku'),quantity:String(int(l,'qty')),unit_amount:{currency_code:'USD',value:formatMinor(int(l,'unit_minor'),'USD')}}))}]};
}
