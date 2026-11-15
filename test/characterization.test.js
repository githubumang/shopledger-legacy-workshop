var test = require('node:test');
var assert = require('node:assert/strict');

var coupons = require('../lib/coupons');
var inventory = require('../lib/inventory');
var ledger = require('../lib/ledger');
var orders = require('../lib/orders');
var pricing = require('../lib/pricing');
var invoice = require('../lib/invoice');
var reports = require('../lib/reports');

test('coupon codes are normalized, capped, and inactive codes are rejected', function () {
  assert.equal(coupons.normalizeCode(' save10 '), 'SAVE10');
  assert.equal(coupons.calculateDiscount(2000, 'SAVE10'), 150);
  assert.deepEqual(coupons.validate('DIWALI20', 2000), {
    valid: false,
    error: 'Coupon DIWALI20 has expired'
  });
});

test('cart discount is apportioned before each HSN GST slab is applied', function () {
  var totals = pricing.computeTotals([
    { id: 1, name: 'Rice', hsn: '1006', price: 100, qty: 2 },
    { id: 2, name: 'Tea', hsn: '0902', price: 50, qty: 1 }
  ], 'WELCOME');

  assert.deepEqual(totals, {
    subtotal: 250,
    discount: 12.5,
    taxable: 237.5,
    tax: 18.05,
    cgst: 9.03,
    sgst: 9.02,
    total: 255.55,
    lines: [
      { id: 1, name: 'Rice', hsn: '1006', gstPercent: 5, gross: 200, discount: 10, taxable: 190, tax: 9.5, net: 199.5 },
      { id: 2, name: 'Tea', hsn: '0902', gstPercent: 18, gross: 50, discount: 2.5, taxable: 47.5, tax: 8.55, net: 56.05 }
    ]
  });
});

test('invoice figures use the billed HSN GST and coupon calculations', function () {
  var items = [
    { id: 1, name: 'Rice', sku: 'RICE', hsn: '1006', price: 100, qty: 2 },
    { id: 2, name: 'Tea', sku: 'TEA', hsn: '0902', price: 50, qty: 1 }
  ];
  var ledgerFigures = pricing.computeTotals(items, 'WELCOME');
  var order = {
    id: 1001,
    date: '2026-11-15',
    customer: 'Asha',
    coupon: 'WELCOME',
    items: items,
    subtotal: ledgerFigures.subtotal,
    discount: ledgerFigures.discount,
    tax: ledgerFigures.tax,
    total: ledgerFigures.total
  };
  var invoiceFigures = invoice.computeInvoiceFigures(order);

  assert.deepEqual({
    subtotal: ledgerFigures.subtotal,
    discount: ledgerFigures.discount,
    tax: ledgerFigures.tax,
    total: ledgerFigures.total
  }, { subtotal: 250, discount: 12.5, tax: 18.05, total: 255.55 });
  assert.deepEqual(invoiceFigures, {
    subtotal: 250,
    discount: 12.5,
    tax: 18.05,
    cgst: 9.03,
    sgst: 9.02,
    total: 255.55,
    rows: [
      { name: 'Rice', sku: 'RICE', hsn: '1006', qty: 2, price: 100, gstPercent: 5, line: 200, lineTax: 9.5 },
      { name: 'Tea', sku: 'TEA', hsn: '0902', qty: 1, price: 50, gstPercent: 18, line: 50, lineTax: 8.55 }
    ]
  });

  var reconciliation = reports.getGstReconciliation({ orders: [order] });
  assert.deepEqual(reconciliation, {
    totalChecked: 1,
    mismatchCount: 0,
    totalDelta: 0,
    rows: [{
      orderId: 1001,
      date: '2026-11-15',
      customer: 'Asha',
      coupon: 'WELCOME',
      ledgerSubtotal: 250,
      ledgerDiscount: 12.5,
      ledgerTax: 18.05,
      ledgerTotal: 255.55,
      invoiceDiscount: 12.5,
      invoiceTax: 18.05,
      invoiceTotal: 255.55,
      delta: 0,
      matched: true
    }]
  });

  var html = invoice.render(order);
  assert.match(html, /Invoice Total<\/td><td class="r">₹255\.55/);
  assert.doesNotMatch(html, /Accountant Reconciliation Notice/);
  assert.match(html, /<td class="r">5%<\/td>/);
});

test('stock check keeps a one-unit buffer below sellable stock', function () {
  var products = [{ id: 1, name: 'Rice', stock: 5, reserved: 2 }];

  assert.equal(inventory.getSellableStock(products[0]), 3);
  assert.deepEqual(inventory.check(products, [{ id: 1, qty: 2 }]), { ok: true });
  assert.deepEqual(inventory.check(products, [{ id: 1, qty: 3 }]), {
    ok: false,
    msg: 'Rice is out of stock (3 sellable available)'
  });
});

test('khata charges respect the credit limit and settlements reduce the balance', function () {
  var db = {
    customers: [{ id: 1, name: 'Asha', creditLimit: 100, openingBalance: 20, totalBilled: 30, totalSettled: 0 }],
    settlements: [],
    nextSettlementId: 501
  };

  assert.equal(ledger.chargeOrderToKhata(db, 1, 51).ok, false);
  assert.equal(ledger.chargeOrderToKhata(db, 1, 50).ok, true);
  var result = ledger.recordSettlement(db, 1, 25, 'cash', 'part payment');

  assert.equal(result.ok, true);
  assert.equal(result.customer.balance, 75);
  assert.equal(result.settlement.id, 501);
  assert.equal(db.settlements.length, 1);
});

test('cancelling an order twice is rejected and current order item ids do not release reservations', function () {
  var db = {
    products: [{ id: 1, stock: 8, reserved: 2 }],
    orders: [{ id: 1001, status: 'completed', paymentMode: 'cash', total: 10, items: [{ id: 1, qty: 1 }] }]
  };

  assert.equal(orders.cancel(db, 1001, 'test').ok, true);
  assert.equal(db.orders[0].status, 'cancelled');
  assert.equal(db.products[0].reserved, 2);
  assert.deepEqual(orders.cancel(db, 1001).error, 'Order #1001 is already cancelled');
});
