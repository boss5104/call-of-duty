/* ===== ตั้งค่าระบบ Duty Call =====
 * API_URL : ใส่ Web app URL ของ Google Apps Script (ลงท้ายด้วย /exec)
 *           ถ้าเว้นว่าง ระบบจะทำงานใน "โหมดทดลอง" (เก็บข้อมูลในเครื่องนี้เท่านั้น)
 *           หรือส่งต่อผ่านลิงก์ก็ได้: index.html?api=https://script.google.com/macros/s/xxx/exec
 * TEAMS   : รายชื่อทีมที่ให้เลือกตอนลงทะเบียน (พิมพ์ทีมอื่นเองได้)
 */
window.DUTY_CONFIG = {
  API_URL: 'https://script.google.com/macros/s/AKfycbxv89k08T6czXOIsI9EqQOOyQPROs-lK5YcKUnGvqOMm-pniw8rbZrhMvde2__b7eV5xA/exec',
  TEAMS: ['ทีม Alpha', 'ทีม Bravo', 'ทีม Charlie', 'ทีม Delta', 'ฝ่ายอำนวยการ'],
  STAFF_POLL_MS: 4000,
  COMMANDER_POLL_MS: 3000,
  ORG_NAME: 'ระบบเรียกปฏิบัติหน้าที่'
};
