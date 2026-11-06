# Taiwan Cruise 操控開發交接文件

給接手的 AI（Cursor 本地 Agent、Codex、Claude Code 等）與開發者。整理自 2026-11-06 與雲端審查 Agent 的完整對話。
回覆使用者時一律使用繁體中文；使用者在台灣（UTC+8）。

## 1. 專案目標

- three.js 悠閒開車遊戲：南投台14線 → 台14甲 → 武嶺。之後要多人連線、街景、自然景觀（樹、草）、天氣系統。
- 現階段只做「車子操控手感」，場景先不做。手感目標：接近《極限競速 地平線》普通難度、預設輔助全開的感覺。
- 之後確定要加：不同汽車車款、公車（含三軸以上）、機車。

## 2. 技術棧與核心決策

- three.js、Rapier（`@dimforge/rapier3d-compat` 鎖定 0.21.0，`setCanSleep(false)`）、TypeScript strict、Vite、Vitest、Tweakpane。
- **不用 Rapier 內建 `DynamicRayCastVehicleController`**。Rapier 只負責：車身剛體、碰撞、射線偵測地面、`applyImpulseAtPoint` 施力。懸吊、輪胎、輪速、引擎、變速箱、差速器、所有輔助系統都在 `src/vehicle/` 自己算。原因：內建控制器沒有輪胎滑移曲線與輪速，做不出地平線手感，也做不了 ABS／TCS／甩尾。
- 碰撞繼續交給 Rapier，與自寫車輛模型不衝突。之後注意：輪子只是射線沒有碰撞體、射線要排除自己車身、高速穿牆用 CCD、車身與牆摩擦調低、多人時遠端車用 kinematic 剛體。
- 固定步長 120／240 Hz + 插值；每輪射線懸吊；車輪 4 子步。
- 輪胎：正規化 Magic Formula `sin(C·atan(tan(π/2C)·s))`，合成滑移 `s = hypot(κ/κp, tanα/tanαp)`，載重敏感、鬆弛長度。
- 車輪：線性化隱式積分 `ω_new = ω + h(T − rFx0)/(I + h r K)`；煞車鎖死停在 0 不越過。
- 決定性：只保證同一台機器、同一個瀏覽器。多人連線要以伺服器或主控端為準。

## 3. 文件與程式位置

本 repo（andycow/react-rnd，分支 `cursor/taiwan-cruise-handling-docs-0a84`）的 `taiwan-cruise-handling/`：

- `taiwan-cruise-handling-prompt-v1.5.pdf`：給 Codex 的操控規格（經 v1.1→v1.5 四輪審查）
- `reference/`：PDF 對照用 TypeScript 參考實作與測試
- `handoff/`：本交接文件、獨立探測測試、三版探測結果

Codex 的實作專案 `TaiwanCruise` 在使用者的 Mac 上（`HuangdeMac-mini.local`），透過 Google Drive 連結
`https://drive.google.com/file/d/1FOcLeoRREdOgkBnbeMleiOiFHDpTAIfn/view` 分享 zip（同一連結會覆蓋更新）。
專案內有 git，審查時的最新 commit：

```
c1790c2 Restore intentional handbrake turns with predictive stability handoff
bb79a81 Fix handbrake recovery and substep ABS with strict handling matrices
e8b63cf Record Phase 7 baseline before handling recovery revisions
```

## 4. 審查歷程

### 第一輪（Codex 初版，無 git）

- typecheck 通過、309 測試通過、操控報告 13 項 PASS，皆重現。
- 發現：Codex 的手煞測試只測「60 km/h 拉 0.2 s」。獨立探測：60 km/h 拉 0.5 s 會打轉約 80°；80 km/h 輕拉 0.2 s 後軸卡在 33° 側滑超過 2 s，連反打到底＋油門全放都救不回。
- 根因：自動反打被 `countersteerMaxRad` 15° × strength 截到 10.9°（實際需約 20°）；玩家反打與自動反打取 max，玩家輸入被吃掉；STM 前輪煞車 800 N·m 頂滿、積分卡 0.2，飽和超過 1.5 s。
- 其他：tmp/ 17 MB 雜檔、舊 reference/src 未清、skidpad 0.9547 g 僅勉強過 0.95、ABS 每車身步只算一次導致 120/240 Hz 煞距差 5%。

### 第二輪（bb79a81）

- 新增 72 條手煞矩陣、108 條閉迴路玩家（k = 0.02／0.04／0.08）、ABS 移入車輪子步（跨頻率差 0.25%）、μ_lat 1.08→1.11（skidpad 0.981 g，門檻拉高到 0.97）。
- 高速打轉全修好。
- **但修過頭**：40 km/h 方向打滿＋手煞，1.5 s 偏航：不拉 66°、拉 0.4 s 只有 38°、0.8 s 51°。手煞反而讓車轉更少（handbrakeStability 在後軸 12°→25° 把手煞扭矩降到 10%，加上恢復邏輯提早介入）。
- 舊單元測試「STM 與反打各自改善恢復（1 秒末端 2 倍比較）」失敗：兩邊都 < 0.05°，近零比倍數無意義。

### 第三輪（c1790c2，目前版本）— 通過

- 新增「刻意甩尾意圖」：玩家持續同向轉向時保留手煞權限、不提前拉回；危險度改用 `|β| + 外擴速率 × 預測時間`，風險區間 30–45°。
- 舊單元測試改為整秒累積後軸滑角，STM 須減少 ≥10%，兩邊末端都 < 0.5° 才跳過單點倍數比較。
- 驗證重現：typecheck、build 通過；354 測試 0 失敗；handling-report 全 PASS（13 項、ABS 跨頻率、72、108、新增 8 組手煞增益）。
- 獨立探測（`handoff/probe-results/v3-c1790c2.txt`）：
  - 髮夾彎 40 km/h：拉 0.4 s 96°、0.8 s 129°（最大 β 45°，不打轉）；60、80 km/h 也都比不拉轉更多。
  - 拉完手煞繼續打滿：60–100 km/h 最大 β 37–43°，不打轉。
  - 放手回正：0.4–0.9 s。
  - 100 km/h 變換車道、彎中重煞、彎中收油：三版數字幾乎相同，一般駕駛無退步。

### 目前已知、暫不處理的觀察

1. 甩尾角度上限約 45°（刻意設計）。想要長時間大角度漂移時再調 `intentRiskStartRad`／`intentRiskEndRad`。
2. 108 條閉迴路最慢一組只快 15.0%，正好壓門檻，之後調參可能浮動失敗，先判斷是否邊緣浮動再找 bug。
3. 輔助層數很多（意圖、風險預測、恢復對齊、STM 側滑恢復、手煞保護、離合釋放），改一個參數可能影響其他，每次改完都要重跑 handling-report。
4. 極低速、後軸滑角快速變化時，單步輪角最多跳約 4.3°，實際開時留意方向盤是否抽動。
5. 0.5 m 落下射線輪胎吃進地面 17–22 mm；Rapier WASM 打包大檔警告（不影響）。

## 5. 下一步（依序）

1. **使用者親自試開**。數據已無明顯問題，手感只能靠實際開。重點觀察：
   - 一般過彎轉向反應是否太鈍或太靈
   - 手煞過髮夾彎的甩尾量與可控性
   - 甩尾中主動反打，車是否照玩家意思走，還是被輔助搶方向盤
   - 輔助介入是否太明顯（「不像自己在開」）
   - 極低速方向盤是否抖動
   使用者回報的感受要轉成可量測的探測情境，再寫給 Codex 的修改 prompt（先寫失敗測試再改，不准放寬門檻或寫特例）。
2. 手感確認後，才送「多載具架構預備」prompt（第 6 節）。該 prompt 要求重構前後 Replay 位元級一致，所以手感要先定下來。
3. 公車與機車各自是之後的獨立大階段，屆時寫跟 v1.5 PDF 同等詳細的規格。

## 6. 尚未送出的 prompt：多載具架構預備

```
專案確定之後要加入多種載具：不同汽車車款、公車（含三軸以上大型車）、機車。
這一階段只做「架構預備」，不實作公車與機車本身，目標是之後新增載具時不用重寫既有系統。

【最高原則】
現有汽車的行為必須完全不變：
- 原 13 項報告、ABS 跨頻率、72 條手煞矩陣、108 條閉迴路、手煞甩尾增益驗收全部 PASS
- 同一份 Replay 在重構前後逐步狀態完全一致（位元級相同，不是「接近」）
先在重構前錄下 120/240 Hz 各數段代表性 Replay 當基準，重構後逐筆比對。

【1. 通用載具介面】
建立 Vehicle 之上的共用介面（例如 DrivableVehicle），相機、HUD、遙測、重播、調校面板、輸入、未來多人同步只能透過這個介面讀寫：
- 姿態、速度、角速度
- 輪子清單（數量不固定，每輪的位置、轉向角、轉速、懸吊長度、接地、Fx/Fy/Fz、gripUsage）
- 引擎轉速、檔位、車速
- 輔助系統狀態（以通用 key/value 呈現，不寫死 ABS/TCS/STM 欄位）
- 序列化／反序列化（Replay 與多人同步共用）
- step(dt, input) 與 reset(pose)
輸入改成通用格式：throttle、brake、steer、handbrake、shift、以及保留給機車的 lean 欄位（汽車忽略）。
現有 Vehicle 改名或包裝成 CarVehicle 實作此介面。
請列出所有原本直接依賴 Vehicle 內部欄位的地方，全部改走介面。

【2. 汽車支援任意軸數】
目前程式寫死四輪（[Wheel, Wheel, Wheel, Wheel] tuple），改成以「軸」為單位的設定：
- 每軸：位置、輪距、是否轉向（含轉向比，供後軸隨動轉向）、是否驅動、是否有手煞、煞車比例、懸吊與防傾桿參數
- 每軸單輪或雙輪（公車後軸常是雙輪），雙輪可先以等效單輪模擬，但介面要保留
- 差速器：每個驅動軸各自一個，多驅動軸之間保留中央差速設定
- Ackermann 改成依各轉向軸到參考後軸距離計算，不寫死前軸
現有車設定為 2 軸，結果必須與重構前位元級相同。

【3. Preset 架構】
- preset 增加 vehicleClass：car / bus / motorcycle
- 分成「物理規格」（質量、慣量、尺寸、軸、輪胎、引擎、變速箱）與「輔助調校」（各輔助系統門檻）兩層，同一台車可套 forza_normal / sport / sim
- 載入時驗證，缺欄位或不合理數值（例如重心高於車頂、軸距為負）要明確報錯
- 新增一份「前驅家用車」preset（約 1300 kg、FWD），只要求能開、基本測試能過，不要求調校完成，用來證明多車款流程可行

【4. 為公車預留，但先不實作】
請在文件中列出之後公車需要、目前尚未處理的項目，不要現在實作：
- 高重心的側翻偵測與防側翻輔助
- 氣壓煞車的建壓延遲
- 長軸距的低速轉彎與內輪差
- 大慣量對 STM、手煞保護、轉向窗口門檻的影響
- 公車不應有手煞甩尾能力（手煞保護應可整個改為停車用）

【5. 為機車預留，但先不實作】
機車不是用汽車改參數，之後會是獨立的 MotorcycleVehicle 實作同一個介面。這階段只要：
- 確認介面不會擋住機車：輪子數為 2、有車身傾角、lean 輸入、停車時需要支撐（側柱狀態）
- 輪胎模組把「外傾推力」留成可擴充（汽車維持現狀，係數為 0）
- 相機與 HUD 不假設車身永遠水平
不要寫任何機車物理。

【驗收】
- 型別檢查、npm test 全綠、npm run handling-report 全 PASS
- 重構前後 Replay 位元級一致的比對報告
- 前驅家用車可以在測試場開，0→100、煞停、定圓數據列在報告中（只記錄，不設門檻）
- 文件：docs/multi-vehicle-architecture.md，說明介面、軸設定、preset 結構，以及公車與機車的待辦清單
- 先建立 git commit 當基準，每個子項各自一個 commit；打包時保留 .git
```

## 7. 換外觀模型、多車款的注意事項

- 換 GLB 外觀不影響物理。`VehicleView.setModel()` 已預留（公尺、原點在重心、車頭 −Z）。但四個輪子目前屬於預設方塊車，換模型後要把 GLB 的輪子拆成獨立物件並接上轉向角、轉速、懸吊長度；模型輪位要對齊物理（軸距 2.65、輪距 1.55、輪半徑 0.33、重心高 0.5）。碰撞體用簡化形狀，不要用精細模型。
- 不同汽車車款：大多改 preset（質量、尺寸、引擎、齒比、懸吊、輪胎；FWD/RWD/AWD 已支援）。輔助門檻是針對目前 1350 kg 後驅車調的，換車要重調並重跑驗證。前驅、四驅尚未驗證過。
- 機車：不能改參數做出來，要獨立的動力學（傾斜、平衡、外傾推力、自動壓車輔助）。

## 8. 審查工作守則（接手的 AI 請遵守）

- 不要只信 Codex 自己的測試：用它沒看過的情境獨立探測（`handoff/independent-probe.test.ts`）。
- 檢查測試門檻有沒有被放寬（`git diff` 看 `expect` 與門檻常數）、有沒有針對特定車速或測試案例寫特例。
- 新舊版用同一份探測對照，確認一般駕駛（變換車道、彎中煞車、收油）沒有退步。
- 給 Codex 的 prompt：先寫失敗的測試再改、不准放寬門檻、不准寫特例、原有驗收全部仍須 PASS、保留 .git。

### 如何跑獨立探測

```bash
cp independent-probe.test.ts <TaiwanCruise>/tests/zz-probe.test.ts
cd <TaiwanCruise>
PROBE_OUT=/tmp/probe.txt npx vitest run tests/zz-probe.test.ts
cat /tmp/probe.txt
rm tests/zz-probe.test.ts
```

探測項目（全部 forza_normal、120 Hz、平地；角度單位為度）：

- A：60／80／100 km/h，方向 0.35／0.6，拉手煞 0.2／0.5／1.0 s，放開後方向回中、油門 0.2。看最大 β、回正時間。
- B：髮夾彎 40／60／80 km/h，方向打滿 2 s 後 0.3，油門 0.3，手煞 0／0.4／0.8／1.2 s。看 1.5 s 與 3 s 累積偏航。
- F：60／80／100 km/h，手煞 0.3–1.0 s，方向打滿到 3 s，油門 0.3／0.8。看是否打轉。
- C：100 km/h 變換車道（方向 ±0.3／0.5／0.8）。
- D：80 km/h 彎中全煞（方向 0.3／0.6）。
- E：80 km/h 彎中收油（方向 0.4／0.7）。

`probe-results/` 有三個版本的結果，可直接比對（v1 檔案是較早的探測版本，缺 B 的 60／80 km/h 與 F）。

探測檔是從 Codex 專案的 `tests/handling-report.test.ts` 複製 setup、cruise、slip 等輔助函式改寫的；若 Codex 之後改了那些函式的簽名，需同步調整。
