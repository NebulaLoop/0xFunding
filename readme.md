# 0xFunding เห็บวาฬ
## Funding Rate Trading Bot

![0xFunding Bot](hepwan.png)

## Introduction

0xFunding เห็บวาฬ เป็นบอทเทรดอัตโนมัติที่ออกแบบมาเพื่อให้เทรดเดอร์สามารถทำกำไรจาก Funding Rate ในตลาด cryptocurrency derivatives โดยเฉพาะ perpetual futures contracts บอทนี้ช่วยให้คุณสามารถจัดการตำแหน่งการเทรดของคุณโดยอัตโนมัติ เพื่อรับ Funding Fee และออกจากตำแหน่งตามกลยุทธ์ที่คุณเลือก

### ทำไมต้องใช้ Funding Rate Bot?

Funding Rate เป็นกลไกที่ใช้ในตลาด perpetual futures เพื่อให้ราคาของสัญญาใกล้เคียงกับราคาในตลาด spot ในช่วงที่ Funding Rate สูงหรือต่ำผิดปกติ จะมีโอกาสทำกำไรโดยการถือตำแหน่งที่เหมาะสม (Long หรือ Short) เพื่อรับ Funding Fee บอทนี้จะช่วยให้คุณทำกำไรจากโอกาสเหล่านี้ได้อย่างมีประสิทธิภาพและอัตโนมัติ

## กลยุทธ์การออกจากตำแหน่ง (Exit Strategies)

บอทเทรด Funding Rate นี้มีตัวเลือกกลยุทธ์การออกจากตำแหน่งการเทรด 3 รูปแบบ ให้คุณเลือกตามสไตล์การเทรดและสภาวะตลาด:

### 1. FixedTpSl (Fixed Take Profit, Stop Loss)

**ลักษณะการทำงาน:**
- ตั้งค่า Take Profit (TP) และ Stop Loss (SL) เป็นเปอร์เซ็นต์ที่แน่นอนจากราคาเข้าตำแหน่ง
- เมื่อเข้าตำแหน่งการเทรด บอทจะวาง TP และ SL order แบบอัตโนมัติ
- ตำแหน่งจะปิดเมื่อราคาแตะถึงระดับ TP หรือ SL ที่กำหนดไว้

**พารามิเตอร์ที่เกี่ยวข้อง:**
- `takeProfitPercent`: เปอร์เซ็นต์กำไรที่ต้องการ (เช่น 1.5% จากราคาเข้า)
- `stopLossPercent`: เปอร์เซ็นต์ขาดทุนที่ยอมรับได้ (เช่น 1% จากราคาเข้า)

**ข้อดี:**
- เป็นกลยุทธ์ที่ตรงไปตรงมา
- ควบคุมความเสี่ยงได้ชัดเจน
- ล็อกกำไรเมื่อราคาขึ้นถึงเป้าหมาย

### 2. TimedExit (Time-Based Exit)

**ลักษณะการทำงาน:**
- กำหนดระยะเวลาที่แน่นอนหลังจากช่วงเวลาจ่าย Funding Rate
- เมื่อครบกำหนดเวลา บอทจะปิดตำแหน่งอัตโนมัติด้วย Market Order โดยไม่สนใจว่ามีกำไรหรือขาดทุน
- ยังคงมี SL ไว้เพื่อป้องกันความเสี่ยงระหว่างรอเวลา

**พารามิเตอร์ที่เกี่ยวข้อง:**
- `exitMinutesAfterFunding`: จำนวนนาทีหลังจากช่วงเวลา Funding ที่จะปิดตำแหน่ง
- `stopLossPercent`: เปอร์เซ็นต์ขาดทุนที่ยอมรับได้ (ใช้เป็น Safety Net)

**ข้อดี:**
- เหมาะกับกลยุทธ์ที่ต้องการเก็บ Funding Fee แล้วออกทันที
- ไม่ต้องถือตำแหน่งนานเกินไป
- ลดความเสี่ยงจากการเคลื่อนไหวของตลาด

### 3. ProfitCheckExit

**ลักษณะการทำงาน:**
- หลังจากเวลา Funding ผ่านไปตามที่กำหนด บอทจะคำนวณกำไรสุทธิ (รวม Funding Fee)
- ถ้ามีกำไรสุทธิ (netPnl > 0) จะปิดตำแหน่งทันที
- ถ้าไม่มีกำไรสุทธิ จะยังคงถือตำแหน่งไว้และพึ่งพา SL

**พารามิเตอร์ที่เกี่ยวข้อง:**
- `exitMinutesAfterFunding`: จำนวนนาทีหลังจากช่วงเวลา Funding ที่จะตรวจสอบกำไร
- `stopLossPercent`: เปอร์เซ็นต์ขาดทุนที่ยอมรับได้

**ข้อดี:**
- ฉลาดในการตัดสินใจออกจากตำแหน่ง
- มองภาพรวมของการเทรด รวมทั้ง Funding Fee
- ลดโอกาสการปิดตำแหน่งด้วยขาดทุน

## เปรียบเทียบกลยุทธ์การออกจากตำแหน่ง

| กลยุทธ์ | เงื่อนไขการออก | เหมาะกับ |
|--------|----------------|---------|
| **FixedTpSl** | เมื่อราคาถึงระดับ TP หรือ SL | การเทรดที่ต้องการควบคุมกำไรและความเสี่ยงอย่างชัดเจน |
| **TimedExit** | เมื่อเวลาที่กำหนดผ่านไป | การเทรดที่ต้องการเก็บ Funding Fee แล้วออกทันที |
| **ProfitCheckExit** | เมื่อมีกำไรสุทธิหลังเวลาที่กำหนด | การเทรดที่ต้องการตัดสินใจออกตำแหน่งโดยพิจารณาจากกำไรสุทธิรวม Funding Fee |

## การเลือกกลยุทธ์ที่เหมาะสม

การเปลี่ยนกลยุทธ์จาก ProfitCheckExit เป็น TimedExit หรือ FixedTpSl จะเปลี่ยนวิธีการตัดสินใจออกจากตำแหน่งของบอทให้เหมาะกับสภาวะตลาดและเป้าหมายการเทรดที่แตกต่างกัน:

- **ตลาดผันผวนสูง**: อาจเลือกใช้ FixedTpSl เพื่อควบคุมความเสี่ยงและล็อกกำไรได้ชัดเจน
- **ช่วง Funding Rate สูงมาก**: อาจเลือกใช้ TimedExit เพื่อเก็บ Funding Fee แล้วออกจากตลาดเร็วที่สุด
- **ตลาดมีแนวโน้มชัดเจน**: อาจเลือกใช้ ProfitCheckExit เพื่อให้มีโอกาสได้ทั้ง Funding Fee และกำไรจากการเคลื่อนไหวของราคา

## เริ่มต้นใช้งาน

1. ตั้งค่าบัญชีและ API key กับ exchange ที่สนับสนุน
2. ติดตั้งและตั้งค่าบอทตามคำแนะนำในเอกสาร
3. เลือกกลยุทธ์การออกจากตำแหน่งที่เหมาะสมกับสไตล์การเทรดของคุณ
4. ตั้งค่าพารามิเตอร์ที่เกี่ยวข้องกับกลยุทธ์ที่เลือก
5. เริ่มต้นรันบอทและตรวจสอบผลการทำงาน

## คำเตือน

การเทรด cryptocurrency มีความเสี่ยงสูง คุณอาจสูญเสียเงินลงทุนทั้งหมดได้ บอทนี้เป็นเพียงเครื่องมือช่วยในการเทรดอัตโนมัติ ไม่ใช่คำแนะนำการลงทุน ควรศึกษาและเข้าใจความเสี่ยงก่อนใช้งาน

 
