# מסמך ייפוי מעודכן — NPS: Nextage Payroll System
### גרסה 2025 | עודכן על בסיס המפרט המקורי מ-2017
### ארגון: Nextage | סביבה: Microsoft Azure + Microsoft 365

---

> **הערת פתיחה:** מסמך זה מבוסס על קובץ המקור `NPS - Nextage Payroll System.pdf` שנכתב ב-15 באוקטובר 2017 על ידי Traisoft Software בע"מ. כל הלוגיקה העסקית המקורית נשמרה — רק היישום הטכנולוגי עודכן לסטנדרטים של 2025 בהתאם לסביבת Azure + Microsoft 365 של Nextage.

---

# שלב 1: סיכום מנהלים — מה משתנה ומה נשאר

## מה המערכת המקורית עושה
NPS (Nextage Payroll System) היא מערכת web-based המשמשת כצינור מרכזי להעברת נתוני שכר בין Nextage לבין לקוחותיה. המערכת מרכזת את כל נתוני השכר, ההעסקה והעובדים של לקוחות Nextage, ומאפשרת לרואי חשבון/מחשבי שכר של Nextage לייצא קבצים תואמים לתוכנת השכר "שיקלולית". בנוסף, המערכת מספקת ממשק לעובדי הלקוחות לצפות בנתוני השכר שלהם, ממשק chatbot לתמיכה, ניהול מסמכים מצורפים, ותזמון אוטומטי של תהליכי חודש.

## אלמנטים מיושנים שזוהו

### טכנולוגיה
| תחום | בעיה |
|---|---|
| .NET Framework (לא Core/8) | EOL — אין תמיכה אקטיבית ב-Windows בלבד |
| TFS (Team Foundation Server) | הוחלף ב-Azure DevOps / GitHub |
| Google+ SSO | **שירות סגור ב-2019** — דורש החלפה מיידית |
| Internet Explorer support | **דפדפן מת** — הוסר מ-Windows ב-2022 |
| Single SQL Server (לא managed) | ללא HA, ללא geo-redundancy, ללא auto-backup |
| MVC monolith (ASP.NET MVC) | ארכיטקטורה ישנה, ללא API-first |
| Cache ידני בצד client | לא אמין, לא מסוכרן, ללא invalidation strategy |
| אימות סיסמה מקומי בלבד | ללא MFA, ללא Zero Trust |

### UX / ממשק משתמש
- אין תיאור design system מוגדר
- מסכים מתוארים בשפה טכנית בלבד ללא wireframes מובנים
- אין תמיכה מוגדרת ב-accessibility (WCAG)
- ממשק הchatbot מתואר כרעיון בלבד ללא spec מוגמר

### ארכיטקטורה
- אין API contracts (OpenAPI/Swagger)
- אין CI/CD pipeline מוגדר
- אין observability (logging מבנה, tracing, alerting)
- אין secrets management מוגדר
- DB schema ראשוני בלבד (7 טבלאות ללא relations)

## מה משתנה מול מה נשאר

| נושא | מקורי 2017 | מעודכן 2025 | סטטוס |
|---|---|---|---|
| לוגיקה עסקית — ניהול שכר | ✅ נשאר | ✅ נשאר | ללא שינוי |
| integrations — Priority, N-Files, Shiklulit | ✅ נשאר | ✅ נשאר, עם API מוגדר |  |
| ייצוא לקבצי שכר (CSV/TXT/XLS) | ✅ נשאר | ✅ נשאר | ללא שינוי |
| כרטיס עובד + כרטיס לקוח | ✅ נשאר | ✅ נשאר, UX מעודכן |  |
| יומן + תזמון סגירת חודש | ✅ נשאר | ✅ נשאר, + webhooks |  |
| SSO | Google+ (מת) | **Microsoft Entra ID (Azure AD)** | 🔴 חובה להחליף |
| Platform | .NET Framework | **.NET 8 (LTS)** | 🔄 upgrade |
| DB | SQL Server self-hosted | **Azure SQL Database (Managed)** | 🔄 migrate |
| Source Control | TFS | **Azure DevOps / GitHub** | 🔄 migrate |
| API | ללא contracts | **OpenAPI 3.x** | ➕ חדש |
| Observability | ללא | **Azure Monitor + Application Insights** | ➕ חדש |
| Secrets | ללא | **Azure Key Vault** | ➕ חדש |
| CI/CD | ללא | **Azure DevOps Pipelines** | ➕ חדש |
| Chatbot | Webtech חיצוני | **Azure Bot Service + Azure OpenAI** | 🔄 שדרוג |
| Notifications | Email בלבד | **Email + Teams + In-app** | 🔄 שדרוג |

## מורכבות מודרניזציה: **גבוהה (High)**

**הצדקה:**
- החלפת Google+ SSO היא דרישה קריטית מיידית (השירות כבר לא קיים)
- מיגרציה מ-.NET Framework ל-.NET 8 דורשת refactoring משמעותי
- הגדרת API contracts מאפס לכל ה-endpoints
- הגדרת מודל נתונים מלא (7 טבלאות בלבד — לא מספיק)
- הוספת כל שכבת אבטחה (MFA, Zero Trust, RBAC מבוסס Entra ID) מאפס
- כלים חדשים: observability, CI/CD, IaC
- עם זאת: הלוגיקה העסקית ברורה ומוגדרת, Azure כבר קיים בארגון — מה שמפחית סיכון

---

# שלב 2: טבלת מודרניזציה טכנולוגית

| רכיב מקורי (2017) | המלצה מודרנית (2025) | סיבה | מורכבות מיגרציה |
|---|---|---|---|
| **.NET Framework / ASP.NET MVC** | **.NET 8 LTS + ASP.NET Core** | .NET Framework הוא Windows-only, ללא תמיכה עתידית. .NET 8 הוא cross-platform, performant, ומקבל תמיכה עד 2026+ | Medium |
| **C#** | **C# 12** | שדרוג שפה בלבד — תאימות גבוהה | Low |
| **Microsoft SQL Server (self-hosted / single)** | **Azure SQL Database (Serverless / General Purpose Tier)** | Managed service עם HA אוטומטי, backups, geo-redundancy, ו-built-in security. מתאים כי הארגון כבר ב-Azure | Medium |
| **Microsoft Azure (general)** | **Microsoft Azure — שירותים ספציפיים** | כבר נבחר בארגון — יש לעבור לשימוש ב-PaaS ספציפיים (App Service, Key Vault, etc.) | Low |
| **Google+ SSO** ⚠️ **שירות מת!** | **Microsoft Entra ID (Azure AD) + OAuth 2.0 / OIDC** | Google+ נסגר ב-2019. Entra ID הוא Identity Provider הארגוני של Microsoft 365, תומך SSO, MFA, Conditional Access | **High — חובה מיידית** |
| **Active Directory (on-prem login)** | **Microsoft Entra ID (Cloud) + Hybrid Join** | מאפשר SSO לכלל אפליקציות Microsoft 365 ו-Azure, עם MFA מובנה | Medium |
| **Team Foundation Server (TFS)** | **Azure DevOps (Repos + Pipelines)** | TFS on-prem הוחלף. Azure DevOps הוא הפתרון הענני של Microsoft עם Git, CI/CD, boards | Low |
| **Microsoft Visual Studio (IDE)** | **Visual Studio 2022 + VS Code** | שדרוג גרסה בלבד — תאימות מלאה | Low |
| **MVC Monolith (WebService)** | **Modular Monolith + Clean Architecture** | בהתאם לגודל המערכת — monolith מודולרי עם separation ברורה בין domains (Payroll, Employees, Clients, Auth, Notifications) | Medium |
| **Cache ידני (client-side)** | **Redis Cache (Azure Cache for Redis)** | caching מסוכרן, distributed, עם TTL ו-invalidation policy ברורים | Medium |
| **Email Notifications בלבד** | **Azure Communication Services + Microsoft Graph API (Teams/Outlook)** | שליחת email, Teams notifications, ו-in-app — כולן דרך Microsoft ecosystem | Low |
| **Chatbot — Webtech חיצוני** | **Azure Bot Service + Azure OpenAI (GPT-4o)** | פתרון native Azure, תמיכה ב-Hebrew NLP, ניתן לשלב ב-Teams | High |
| **Internet Explorer** ⚠️ **מת!** | **הסרה מלאה** | IE הוסר מ-Windows ב-2022. אין לתמוך בו | Low |
| **ייצוא PDF** | **QuestPDF (open source, .NET)** | ספרייה מודרנית ל-.NET, מחליפה RDLC/Crystal Reports | Low |
| **ייצוא Excel/CSV** | **ClosedXML + CsvHelper** | ספריות open source ל-.NET, ללא תלות ב-Office | Low |
| **DB Tables בלבד (ללא ORM)** | **Entity Framework Core 8 (Code First)** | ORM מודרני, migrations אוטומטיות, type-safe queries | Medium |
| **ללא API Contracts** | **OpenAPI 3.x + Swagger UI (Swashbuckle)** | תיעוד אוטומטי, code generation ללקוחות, testing קל | Medium |
| **ללא Observability** | **Azure Application Insights + Azure Monitor** | structured logging, distributed tracing, alerting — native Azure | Low |
| **ללא Secrets Management** | **Azure Key Vault** | ניהול מפתחות, connection strings, certificates בצורה מאובטחת | Low |
| **ללא CI/CD** | **Azure DevOps Pipelines (YAML)** | automated build, test, deploy לכל environment | Medium |
| **ללא IaC** | **Bicep (Azure native IaC)** | הגדרת תשתית כקוד, repeatable deployments | Medium |
| **Frontend — ASP.NET Razor (MVC)** | **React 18 + TypeScript + Vite** | SPA מודרני, responsive, RTL support מלא, PWA-ready | High |
| **UI Components — ללא library** | **Fluent UI React v9 (Microsoft)** | design system של Microsoft — מתאים לארגון Microsoft 365, תמיכה RTL מובנית, accessibility | Medium |
| **Authentication בצד שרת בלבד** | **Microsoft Authentication Library (MSAL.js) + ASP.NET Core Identity** | OIDC flows מלאים, token refresh, secure storage | Medium |

---

# שלב 3: עדכון ארכיטקטורה

## עקרונות יסוד — 2025

```
Cloud-Native on Azure | API-First (OpenAPI 3.x) | Zero Trust Security
Modular Monolith → מוכן להפרדה למיקרו-שירותים | CI/CD ב-Azure DevOps
Observability: Application Insights | Identity: Microsoft Entra ID
```

## 3.1 תרשים ארכיטקטורה (תיאור טקסטואלי)

```
┌─────────────────────────────────────────────────────────────────┐
│                    CLIENTS (Browsers / Mobile)                  │
│          React 18 SPA + MSAL.js (Entra ID Token)                │
└─────────────────────────┬───────────────────────────────────────┘
                          │ HTTPS / JWT Bearer
┌─────────────────────────▼───────────────────────────────────────┐
│                    Azure Front Door (CDN + WAF)                  │
│         Global load balancing, DDoS protection, TLS termination  │
└─────────────────────────┬───────────────────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────────────────┐
│              Azure App Service (API Backend)                     │
│         ASP.NET Core 8 — Modular Monolith                        │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────┐   │
│  │ Auth     │ │ Payroll  │ │ Employee │ │ Notifications    │   │
│  │ Module   │ │ Module   │ │ Module   │ │ Module           │   │
│  └──────────┘ └──────────┘ └──────────┘ └──────────────────┘   │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────┐   │
│  │ Client   │ │ Reports  │ │ Files    │ │ Integration      │   │
│  │ Module   │ │ Module   │ │ Module   │ │ Module           │   │
│  └──────────┘ └──────────┘ └──────────┘ └──────────────────┘   │
└───────┬─────────────┬────────────┬────────────────┬────────────┘
        │             │            │                │
┌───────▼──┐   ┌──────▼───┐  ┌────▼─────┐  ┌──────▼──────────┐
│Azure SQL │   │Azure     │  │Azure     │  │ Azure Service   │
│Database  │   │Cache     │  │Blob      │  │ Bus             │
│(Primary) │   │(Redis)   │  │Storage   │  │ (Events/Queue)  │
└──────────┘   └──────────┘  └──────────┘  └─────────────────┘
        │
┌───────▼──────────────────────────────────────────────────────┐
│              External Integrations Layer                      │
│  Priority API │ N-Files API │ CIBUS API │ Shiklulit (file)   │
│  BMP API      │ Microsoft Graph API (Mail/Teams)             │
└──────────────────────────────────────────────────────────────┘
        │
┌───────▼──────────────────────────────────────────────────────┐
│              Observability & Security                         │
│  Azure Application Insights │ Azure Monitor │ Azure Key Vault│
│  Microsoft Entra ID (OAuth2/OIDC) │ Azure Security Center    │
└──────────────────────────────────────────────────────────────┘
```

## 3.2 השוואה רכיב-רכיב: מקורי vs. מודרני

### רכיב 1: שכבת הצגה (Frontend)

| | מקורי | מודרני |
|---|---|---|
| **גישה** | ASP.NET Razor MVC — server-side rendering | React 18 SPA — client-side rendering + SSR אפשרי |
| **שפה** | C# + HTML + JavaScript | TypeScript + React + Fluent UI v9 |
| **ניהול state** | ViewState / Session | React Query + Zustand |
| **RTL** | ידני | Fluent UI v9 תמיכה מובנית ב-RTL |
| **תועלת** | — | ביצועים, UX מודרני, PWA, offline capability |

### רכיב 2: Backend / API

| | מקורי | מודרני |
|---|---|---|
| **גישה** | ASP.NET MVC WebService — monolith | ASP.NET Core 8 — Modular Monolith + REST API |
| **API contracts** | ללא | OpenAPI 3.x + Swagger UI |
| **Pattern** | MVC | Clean Architecture (Controllers → Services → Repositories) |
| **Auth** | Session-based | JWT Bearer + OAuth2/OIDC via Entra ID |
| **תועלת** | — | Testable, maintainable, API clients auto-generated |

### רכיב 3: Database

| | מקורי | מודרני |
|---|---|---|
| **גישה** | Single SQL Server (self-hosted, unclear) | Azure SQL Database — Managed, General Purpose Tier |
| **ORM** | ללא / ADO.NET ידני | Entity Framework Core 8 |
| **Migrations** | ידני | EF Core Migrations + CI/CD |
| **Backup** | לא מוגדר | Automated backups + PITR (35 יום) |
| **HA** | לא מוגדר | Built-in 99.99% SLA |
| **תועלת** | — | אמינות, אבטחה, עלות-תועלת |

### רכיב 4: Authentication & Authorization

| | מקורי | מודרני |
|---|---|---|
| **SSO** | Google+ (מת!) + AD | Microsoft Entra ID (Azure AD) + OIDC |
| **MFA** | ללא | Entra ID Conditional Access + MFA |
| **Permissions** | Custom permission table בלבד | RBAC ב-Entra ID + Custom permissions בDB |
| **Token** | Session | JWT + Refresh Token (MSAL) |
| **תועלת** | — | Zero Trust, SSO עם Microsoft 365, אין סיסמאות מקומיות |

### רכיב 5: Notifications

| | מקורי | מודרני |
|---|---|---|
| **ערוץ** | Email בלבד | Email + Microsoft Teams + In-app notifications |
| **שליחה** | SMTP ישיר (לא מוגדר) | Microsoft Graph API (Mail) + Azure Communication Services |
| **תזמון** | לא מוגדר | Azure Functions (Timer-triggered) + Azure Service Bus |
| **תועלת** | — | אמינות, delivery tracking, תמיכה ב-Teams |

### רכיב 6: File Storage

| | מקורי | מודרני |
|---|---|---|
| **אחסון** | לא מוגדר (ככל הנראה DB / file system) | Azure Blob Storage (Hierarchical namespace) |
| **גישה** | ישירות מה-DB | Signed URLs + SAS tokens |
| **תועלת** | — | אחסון זול, CDN-ready, secure access |

### רכיב 7: CI/CD

| | מקורי | מודרני |
|---|---|---|
| **קיים** | ללא | Azure DevOps Pipelines (YAML) |
| **שלבים** | — | Build → Test → Security Scan → Deploy to Staging → Approval → Deploy to Prod |
| **IaC** | ללא | Bicep templates |

### רכיב 8: Observability

| | מקורי | מודרני |
|---|---|---|
| **Logging** | ללא מוגדר | Structured JSON logging + Application Insights |
| **Tracing** | ללא | Distributed tracing (Application Insights) |
| **Alerting** | ללא | Azure Monitor Alerts + PagerDuty / Teams |
| **Dashboard** | ללא | Azure Monitor Workbooks |

---

# שלב 4: מודרניזציה UX — מסך אחר מסך

> **ספריית UI מומלצת:** [Fluent UI React v9](https://react.fluentui.dev/) — ספריית design system רשמית של Microsoft. מתאימה לארגון Microsoft 365, תמיכה RTL מובנית, accessibility WCAG 2.1 AA, ו-dark mode מובנה.

---

## מסך 1: Login Screen

**1. שם המסך:** מסך כניסה למערכת

**2. תיאור מקורי:** כניסה עם email + סיסמה, או דרך Google+ (מת). ציוין שניתן לבצע reset סיסמה.

**3. עדכון UX מודרני:**
כניסה מאוחדת דרך Microsoft Entra ID בלבד — כפתור "Sign in with Microsoft" יחיד. המשתמש מנותב לדף האימות של Microsoft (SSO), תומך MFA אוטומטי. אין סיסמה מקומית — פישוט קיצוני של חוויית הכניסה.

**4. רכיבי UI:**
- `FluentProvider` (Fluent UI v9 wrapper עם RTL)
- כרטיס login עם לוגו Nextage + לוגו NPS
- כפתור `<Button appearance="primary">` — "התחבר עם Microsoft"
- Spinner בזמן auth flow
- הודעת שגיאה (`MessageBar`) אם הכניסה נכשלה
- קישור "צור קשר עם מנהל המערכת"

**5. היררכיה ופריסה:**
```
[דף מלא — background image / gradient Nextage]
  └── [כרטיס מרכזי — 400px רוחב, shadow עדין]
       ├── [לוגו Nextage + כותרת "NPS"]
       ├── [כפתור "התחבר עם Microsoft" — Microsoft Entra]
       ├── [Divider + "או"]
       └── [קישור עזרה]
```

**6. אינטראקציות:**
- לחיצה על כפתור → redirect ל-Entra ID login page → redirect חזרה עם token
- כישלון auth → `MessageBar` אדום מוחלף בהדרגה (animation)
- Spinner במהלך redirect (300ms לפני)

**7. נגישות (WCAG 2.1 AA):**
- כפתור עם `aria-label="התחבר עם Microsoft"` 
- contrast ratio ≥ 4.5:1
- focus visible על כל האלמנטים
- אין CAPTCHA (מיותר עם Entra ID)

**8. מובייל:**
- כרטיס תופס 90% רוחב מסך
- כפתור גדול (min-height 48px) לנגיעה בטוחה
- keyboard push-up — form לא נחסם על ידי keyboard

---

## מסך 2: Dashboard / דף פתיחה לעובד Nextage

**1. שם המסך:** לוח בקרה ראשי (Dashboard)

**2. תיאור מקורי:** פאנל עליון עם לוגו + חיפוש + התראות. עמודה שמאל: נתוני חברה + יומן + הערות. אמצע: כפתורים לפעולות שכר, חוזים, התכתבויות, דוחות. תחתית: רשימת עובדים עם אפשרות הוספה/ייבוא.

**3. עדכון UX מודרני:**
Dashboard מבוסס כרטיסיות (cards) עם status indicators צבעוניים לכל לקוח. Navigation header קבוע עם breadcrumb. Sidebar מתקפלת לניווט בין מודולים. Notification center בפינה עליונה. Quick actions בכל כרטיס לקוח.

**4. רכיבי UI:**
- `<Toolbar>` עם חיפוש global (Fluent SearchBox) + notification bell + avatar משתמש
- `<Nav>` sidebar מתקפלת (Fluent Nav)
- `<DataGrid>` עם filters, sort, pagination לרשימת לקוחות
- `<Card>` summary לכל לקוח עם status badge (סגור החודש / פתוח / ממתין)
- `<Badge>` notification count
- `<Dialog>` לפעולות מהירות
- `<Toast>` notifications (Fluent v9 Toaster)

**5. היררכיה ופריסה:**
```
[Header — קבוע]
  ├── לוגו NPS + Nextage
  ├── Global Search
  └── Notifications Bell + User Avatar

[Layout — 2 עמודות]
  ├── [Sidebar — 240px, מתקפלת]
  │    ├── לקוחות שלי
  │    ├── ניהול עובדים
  │    ├── יומן שכר
  │    ├── דוחות
  │    ├── הגדרות
  │    └── ניהול (Nextage admin בלבד)
  │
  └── [Main Content]
       ├── [Summary Cards — שורה]
       │    ├── לקוחות פעילים: N
       │    ├── חודש פתוח: N
       │    └── ממתין לסגירה: N
       └── [DataGrid — רשימת לקוחות]
            עמודות: שם חברה | ח"פ | חודש פעיל | סטטוס | פעולות

[Footer — קבוע]
  ├── לוגו Nextage
  └── קישורים למערכות נוספות (Workflow, etc.)
```

**6. אינטראקציות:**
- חיפוש עם auto-complete (debounce 300ms)
- לחיצה על שם לקוח → navigate לכרטיס לקוח
- hover על שורה → quick action buttons מופיעים (fade-in)
- notification bell → `<Popover>` עם רשימת התראות
- סינון DataGrid → URL params מתעדכנים (deep linking)
- ייצוא Excel → download מיידי + toast "הקובץ הורד בהצלחה"

**7. נגישות:**
- `role="navigation"` על ה-sidebar
- DataGrid עם `aria-label="רשימת לקוחות"`, עמודות sortable עם `aria-sort`
- skip-to-content link בראש הדף
- כל הכפתורים עם tooltips

**8. מובייל:**
- Sidebar קולפת ל-hamburger menu
- DataGrid → Card list view במובייל
- Summary cards בשורה אנכית (flex-column)

---

## מסך 3: Company Screens — Payroll Screen (מסך שכר חודשי לחברה)

**1. שם המסך:** מסך שכר חודשי — רמת חברה

**2. תיאור מקורי:** לוגו בשמאל, חיפוש בימין, בחירת חודש, טבלת נתוני שכר לעובדים לאותו חודש, ייצוא/הדפסה, ייבוא מ-Excel. נתונים קבועים מועתקים מחודש לחודש, שדות משתנים בצבע אחר. Submit לנעילת החודש.

**3. עדכון UX מודרני:**
DataGrid אינטראקטיבי עם inline editing, auto-save ל-Redis cache, color coding חכם לסטטוס שדות (שינוי / חוזה / ריק), month picker עם status indicator לכל חודש. Submit flow עם confirmation dialog ו-audit trail. Optimistic UI updates.

**4. רכיבי UI:**
- `<MonthPicker>` עם badge סטטוס (פתוח/נעול/הוגש) לכל חודש
- `<DataGrid>` עם inline editing, frozen columns (שם עובד, מספר עובד)
- Color coding: ירוק = ממחרת חוזה | כחול = שונה ידנית | אפור = ריק
- `<Toolbar>` עם: ייצוא PDF, ייצוא Excel, ייבוא Excel, Submit החודש
- `<MessageBar>` info — "החודש נעול — לפתיחה מחדש פנה למנהל Nextage"
- `<Dialog>` confirmation לפני Submit
- `<Spinner>` inline בשמירת שדה
- Left pane: `<Card>` עם נתוני חברה + יומן + הערות

**5. היררכיה ופריסה:**
```
[Header + לוגו חברה + MonthPicker + Toolbar actions]

[Layout — 2 עמודות]
  ├── [Left Pane — 280px]
  │    ├── נתוני חברה (Card)
  │    ├── יומן סגירות (Card)
  │    └── הערות כלליות (Textarea)
  │
  └── [Main Content]
       ├── [DataGrid — נתוני שכר עובדים]
       └── [Footer row — סיכומים]
```

**6. אינטראקציות:**
- עריכת שדה inline → auto-save ב-Redis cache (debounce 500ms) + Spinner → checkmark
- שינוי ידני של שדה שמגיע מחוזה → warning tooltip "ערך זה שונה מהחוזה" + צביעה
- Submit → `<Dialog>` "האם לנעול את חודש X? לאחר הנעילה לא ניתן לערוך." → נעילה → badge "הוגש"
- ייבוא Excel → drag-and-drop zone → validation errors בטבלה inline
- Keyboard navigation מלאה בטבלה (Tab, Arrow keys, Enter לעריכה)

**7. נגישות:**
- DataGrid עם `role="grid"` ו-`aria-readonly` כשנעול
- שדות שגיאה עם `aria-describedby` לתיאור השגיאה
- Color coding לא לבד — גם icon + tooltip (לא רק צבע)

**8. מובייל:**
- DataGrid → swipable cards per employee
- Left pane מתקפל לAccordion בראש הדף
- Submit button קבוע בתחתית המסך (sticky footer)

---

## מסך 4: Company Settings — הגדרות חברה

**1. שם המסך:** הגדרות חברה

**2. תיאור מקורי:** חלון המאפשר הגדרת פרמטרים שונים: עדכון עובדים שעזבו, ברירות מחדל, הזמנת עובדים למערכת, ייצוא והדפסת רשימת עובדים.

**3. עדכון UX מודרני:**
דף settings מחולק ל-tabs לפי נושאים ברורים: "עובדים", "תבניות שדות", "הרשאות", "שילובים". שמירה אוטומטית עם confirmation toast.

**4. רכיבי UI:**
- `<TabList>` עם tabs: כללי | עובדים | הרשאות | ייצוא/ייבוא | שילובים
- Toggle switches לפרמטרים בוליאניים
- `<Input>` fields עם validation inline
- `<DataGrid>` לרשימת עובדים פעילים/לשעבר
- `<Button>` "הזמן עובד" → email invite via Microsoft Graph
- `<Dropdown>` לברירות מחדל לשדות עובד
- `<Toast>` "ההגדרות נשמרו"

**5. היררכיה ופריסה:**
```
[כותרת דף + breadcrumb]
[TabList]
[Tab Content — תלוי בtab הפעיל]
[Footer — כפתורי שמירה / ביטול]
```

**6. אינטראקציות:**
- Toggle → שמירה מיידית + toast
- "הזמן עובד" → modal עם שדה email + שליחת invite
- ייצוא רשימת עובדים → download ב-2-3 שניות + toast

**7. נגישות:** כל שדות form עם label מפורש, required fields מסומנים, error messages ברורים.

**8. מובייל:** Tabs → DropDown selector. שדות בשורות מלאות.

---

## מסך 5: Employee — Monthly View (כרטיס עובד — תצוגה חודשית)

**1. שם המסך:** כרטיס עובד — תצוגה חודשית

**2. תיאור מקורי:** לחיצה על שם עובד פותחת כרטיס בחלון נפרד. שמאל: פרטים אישיים + פרטי העסקה + הערות. ימין: יכולת מילוי רכיבי שכר לחודש הנוכחי. ייצוא/הדפסה של השכר שאולם לאותו חודש.

**3. עדכון UX מודרני:**
כרטיס עובד פתוח ב-`<Drawer>` (slide-in panel) מימין — לא חלון חדש. שמירת פרטי עובד ב-tabbed layout. Salary components מוצגות בקבוצות (כמו accordion) לפי נושא. Breadcrumb לניווט חזרה לחברה.

**4. רכיבי UI:**
- `<Drawer>` side panel (FullBleed)
- `<TabList>` בכרטיס: פרטים אישיים | שכר חודשי | מסמכים | תיצמת חוזה | טופס 101
- Left pane: `<PersonaHeader>` עם תמונה/אנוטר + שם + תפקיד
- `<Accordion>` לרכיבי שכר מקובצים
- `<Input>` fields עם prefix ל-₪/$
- `<Badge>` color-coded לסטטוס שדה
- Print/Export toolbar

**5. היררכיה ופריסה:**
```
[Drawer — 75% רוחב מסך]
  ├── [Header — שם עובד + breadcrumb + close button]
  ├── [TabList]
  └── [Tab Content]
       ├── [Left col — 30%: פרטים אישיים + הערות]
       └── [Right col — 70%: שכר / מסמכים לפי Tab]
```

**6. אינטראקציות:**
- פתיחת Drawer → slide animation מימין (200ms)
- שמירת שכר → auto-save + checkmark inline
- לחיצה על "הסטוריה" של שדה → `<Popover>` עם טבלת שינויים

**7. נגישות:** `aria-label` על ה-Drawer, `aria-expanded` על accordion sections, focus trap בתוך ה-Drawer.

**8. מובייל:** Drawer תופס 100% רוחב במובייל. Tabs → swipable.

---

## מסך 6: Employee — Attachments (מסמכים מצורפים)

**1. שם המסך:** מסמכים מצורפים לעובד

**2. תיאור מקורי:** Left pane: פרטים אישיים עברית/אנגלית + הערות. Right pane: מסמכים מצורפים לעובד.

**3. עדכון UX מודרני:**
File manager מודרני עם drag-and-drop upload, preview inline, קטגוריזציה (חוזה / שכר / אישי / טפסים), חיפוש במסמכים, גרסאות.

**4. רכיבי UI:**
- `<FileUploadZone>` עם drag-and-drop
- `<DataGrid>` רשימת קבצים: שם | סוג | תאריך | מי העלה | פעולות
- `<Badge>` קטגוריה
- `<Tooltip>` preview בhover
- `<Dialog>` אישור מחיקה
- `<SearchBox>` לחיפוש בשמות קבצים

**5. היררכיה ופריסה:**
```
[Tab "מסמכים" בתוך כרטיס עובד]
  ├── [Toolbar: Upload | Filter by category | Search]
  └── [DataGrid / Card view toggle]
```

**6. אינטראקציות:**
- Drag קובץ → progress bar → toast "הועלה בהצלחה"
- לחיצה על שם קובץ → preview inline (PDF, תמונות) או download
- מחיקה → confirmation dialog

**7. נגישות:** כל הפעולות נגישות במקלדת. קבצים עם `aria-label` מתאים.

**8. מובייל:** רשימה אנכית. Upload מאפשר בחירה מהגלריה.

---

## מסך 7: Employee — Contract Summary (תיצמת חוזה)

**1. שם המסך:** תיצמת חוזה עובד

**2. תיאור מקורי:** חלון המציג את נתוני החוזה החשובים (סוג העסקה, ימי חופשה, סעיף 14 וכו') במבט אחד. הוצע כ-POPUP או כ-collapsible.

**3. עדכון UX מודרני:**
Tab ייעודי "תיצמת חוזה" בכרטיס העובד. מוצג כ-read-only info card עם פרטים מרכזיים + כפתור "עדכן חוזה" שפותח edit flow.

**4. רכיבי UI:**
- `<InfoLabel>` pairs (שדה: ערך) בפריסת 2 עמודות
- `<Badge>` לסטטוס חוזה (פעיל / פג תוקף / בתהליך)
- `<Button>` "עדכן חוזה" → Dialog עם form
- `<Timeline>` שינויי חוזה (היסטוריה)

**5. היררכיה ופריסה:**
```
[Tab — תיצמת חוזה]
  ├── [Summary Card — grid 2 עמודות]
  │    ├── סוג העסקה | שכר בסיס
  │    ├── אחוז משרה | שכר גלובלי/שעתי
  │    ├── סעיף 14 | ימי חופשה שנתיים
  │    └── תאריך תחילת עבודה | ...
  ├── [כפתור עדכן חוזה]
  └── [Timeline — היסטוריית שינויים]
```

**6. אינטראקציות:** לחיצה על "עדכן חוזה" → Dialog עם form + validation. שמירה → חוזה מעודכן + שורה בhistory.

**7. נגישות:** Info cards עם `<dl>/<dt>/<dd>` סמנטי.

**8. מובייל:** Grid עובר ל-1 עמודה.

---

## מסך 8: Employee — Form 101 (טופס 101)

**1. שם המסך:** מילוי טופס 101

**2. תיאור מקורי:** דף אינטרנטי דינמי למילוי ממוחשב של טופס 101. ניתן לבצע גם דרך smartphone. שליחת notification ל-Nextage כשהעובד מסיים. נתונים הופכים ישירות לרשומות.

**3. עדכון UX מודרני:**
Wizard מדורג (stepper) למילוי טופס 101 — 4-5 שלבים ברורים עם validation בכל שלב. פשטות מקסימלית. חתימה דיגיטלית. שמירת טיוטה. Notification ל-Nextage עם link ישיר לבדיקה.

**4. רכיבי UI:**
- `<StepWizard>` / Fluent `<Wizard>` (stepper)
- `<Input>` / `<Select>` / `<DatePicker>` לשדות הטופס
- `<RadioGroup>` לבחירות (נשוי/רווק/גרוש)
- `<SignaturePad>` לחתימה דיגיטלית (canvas-based)
- `<Progress>` bar באחוזים
- Preview PDF לפני שליחה

**5. היררכיה ופריסה:**
```
[Header — "מילוי טופס 101 — [שם עובד]"]
[Stepper — שלב 1/5: פרטים אישיים]
[Form Content — שלב נוכחי]
[Footer — חזרה | המשך / שלח]
```

**6. אינטראקציות:**
- Validation בזמן אמת (blur) + סיכום שגיאות בראש השלב
- בשלב האחרון: Preview → חתימה → שליחה
- לאחר שליחה: toast לעובד + notification email/Teams ל-Nextage

**7. נגישות:** WCAG 2.1 AA מלא — קריטי כי עובדים מגוונים ממלאים. כל שדה עם label מפורש, הוראות ברורות, error messages ב-aria-live.

**8. מובייל:** Wizard מותאם מלאכותית למובייל. חתימה דיגיטלית נוחה לנגיעה. כל שלב מסך אחד.

---

## מסך 9: Notifications / Email Alerts (התראות)

**1. שם המסך:** מרכז התראות

**2. תיאור מקורי:** שליחת email לפי תאריכים ופעולות (למשל שבוע לפני סגירת חודש).

**3. עדכון UX מודרני:**
Notification Center מוטמע באפליקציה (bell icon) + אפשרות Teams notification + email. ניהול ה-rules בממשק ויזואלי. היסטוריית שליחות.

**4. רכיבי UI:**
- `<Badge>` notification count על bell icon
- `<Popover>` עם רשימת notifications אחרונות
- דף "הגדרות התראות" עם `<DataGrid>` של rules
- `<Toggle>` enable/disable לכל rule
- `<DateTimePicker>` לסף ההתראה (X ימים לפני)
- `<Dropdown>` ערוץ: Email / Teams / שניהם

**5. היררכיה ופריסה:**
```
[Header Bell → Popover]
  ├── "לא קראת: 3"
  ├── [רשימת notifications אחרונות]
  └── [קישור "כל ההתראות"]

[דף הגדרות התראות]
  ├── [DataGrid — rules]
  └── [Add Rule button]
```

**6. אינטראקציות:** Toggle rule → immediate save. לחיצה על notification → navigate לדף הרלוונטי.

**7. נגישות:** `aria-live="polite"` על notification count. Focus management בפתיחת Popover.

**8. מובייל:** Popover מלא רוחב.

---

## מסך 10: Chatbot

**1. שם המסך:** צ'אטבוט תמיכה

**2. תיאור מקורי:** מערכת מבוססת AI לצ'אט עם נציג וירטואלי. שיחות נשמרות. יכולת העברה לנציג אמיתי. תומך עברית ואנגלית.

**3. עדכון UX מודרני:**
Chatbot מוטמע כ-floating action button בפינה. מבוסס Azure Bot Service + Azure OpenAI. ממשק Microsoft Teams-like לצ'אט. העברה חלקה לנציג אנושי עם context.

**4. רכיבי UI:**
- `<FAB>` (Floating Action Button) בפינה ימינית-תחתונה
- `<ChatPanel>` — slide-up panel (400x500px)
- Conversation bubbles: agent / user
- `<Spinner>` בזמן thinking
- כפתור "העבר לנציג"
- Typing indicator (3 נקודות)

**5. היררכיה ופריסה:**
```
[FAB — קבוע בכל דף]
[ChatPanel — overlay]
  ├── [Header — "עוזר NPS" + Close + Escalate]
  ├── [Messages area — scrollable]
  └── [Input + Send]
```

**6. אינטראקציות:** FAB → open animation → auto-greet message. Enter/Send. Escalate → notification ל-Nextage agent עם transcript.

**7. נגישות:** `aria-live` על area ההודעות. Focus trap בתוך panel פתוח.

**8. מובייל:** Panel מלא-מסך במובייל.

---

## מסך 11: Permissions / הרשאות

**1. שם המסך:** ניהול הרשאות

**2. תיאור מקורי:** חלון הרשאות לפי קבוצות תפקידים: עובד, מנהל משרד/מנכ"ל, משתמש Nextage, מנהל Nextage.

**3. עדכון UX מודרני:**
מודל RBAC (Role-Based Access Control) ויזואלי. Matrix של roles × permissions. ניהול דרך Entra ID groups + custom permissions בDB.

**4. רכיבי UI:**
- `<Table>` permission matrix (roles בשורות, features בעמודות)
- `<Checkbox>` לכל תא
- `<Select>` לשיוך role למשתמש
- `<DataGrid>` רשימת משתמשים + role שלהם
- `<Dialog>` הוספת משתמש

**5. היררכיה ופריסה:**
```
[Tab "הרשאות" בהגדרות מערכת]
  ├── [DataGrid — משתמשים + roles]
  └── [Permission Matrix — roles × features]
```

**6. אינטראקציות:** שינוי role → immediate effect + audit log entry.

**7. נגישות:** Checkbox table עם `aria-label` מלא לכל תא.

**8. מובייל:** Matrix → accordion per role.

---

## מסך 12: Shiklulit Interface (ממשק לשיקלולית)

**1. שם המסך:** ממשק ייצוא לשיקלולית

**2. תיאור מקורי:** ייצוא קבצי CSV/TXT/Excel בפורמט שתוכנת השיקלולית מבינה. אין API — קובץ בלבד. ייצוא נפרד לכל לקוח.

**3. עדכון UX מודרני:**
Export wizard דו-שלבי: (1) בחר לקוחות (multi-select) → (2) בחר פורמט + הורד. Preview של שורות ראשונות לפני הורדה. Progress bar לקבצים גדולים.

**4. רכיבי UI:**
- `<MultiSelect>` לבחירת לקוחות
- `<RadioGroup>` לפורמט (CSV / TXT / XLSX)
- `<Preview>` טבלה של 5 שורות ראשונות
- `<Button>` "הורד קבצים"
- `<ProgressBar>` + toast לסיום

**5. היררכיה ופריסה:** Wizard 2 שלבים + confirmation.

**6. אינטראקציות:** בחירת לקוחות → preview live → הורדה כ-ZIP (קובץ לכל לקוח).

**7. נגישות:** Multi-select עם keyboard navigation.

**8. מובייל:** פחות שימושי במובייל — בכל זאת מותאם.

---

## מסך 13: Nextage Admin — דף עבודה ראשי

**1. שם המסך:** דף עבודה ראשי למשתמשי Nextage

**2. תיאור מקורי:** טבלה עם רשימת הלקוחות של המשתמש. מיון לפי שם/מספר חברה. אפשרות הוספת לקוח חדש.

**3. עדכון UX מודרני:** זהה ל-Dashboard הראשי — מוצג בView מסונן למשתמש הנוכחי.

**4. רכיבי UI:** `<DataGrid>` עם filters | `<Button>` "לקוח חדש" | `<SearchBox>` | `<Badge>` סטטוסים.

---

## מסך 14: Save Email — שמירת אימייל מ-Outlook

**1. שם המסך:** שמירת אימייל מ-Outlook ל-NPS

**2. תיאור מקורי:** כפתור ב-Outlook (Windows client) לשמירת התכתבויות הקשורות לשכר, מיוון לפי חברה ועובד.

**3. עדכון UX מודרני:**
Outlook Add-in מבוסס **Office Add-ins API** (JavaScript) — עובד ב-Outlook Web, Windows, Mac וב-Teams. כפתור "שמור ב-NPS" ב-ribbon. Dialog לבחירת חברה + עובד + קטגוריה.

**4. רכיבי UI:**
- Ribbon button ב-Outlook
- Task Pane (320px) עם: `<Dropdown>` חברה → `<Dropdown>` עובד → `<RadioGroup>` קטגוריה → `<Button>` שמור
- Toast "נשמר בהצלחה"

**5. תועלת מודרנית:** עובד ב-Outlook Web — לא רק Windows client. מתחבר ל-Microsoft Graph API לשליפת metadata.

---

# שלב 5: מסמך ספציפיקציה מלא — NPS 2025

---

# מסמך דרישות ומפרט מערכת
# NPS — Nextage Payroll System
## גרסה 2.0 | ינואר 2025
### כתב: עודכן לסטנדרטים 2025 בהתבסס על מפרט 2017 מקורי

---

## 1. מבוא

### 1.1 מטרת המערכת

NPS (Nextage Payroll System) היא מערכת web-based המשמשת כ"צינור שכר" מרכזי בין Nextage לבין לקוחותיה. מטרות המערכת:

1. **ריכוז נתוני שכר** — מסד נתונים מרכזי לכל נתוני השכר, ההעסקה, והעובדים של לקוחות Nextage
2. **ממשק בין Nextage ללקוחות** — הכלי היחיד להעברת מידע בין מחשבי השכר של Nextage לבין לקוחות
3. **ייצוא לתוכנת שכר** — יצירת קבצים תואמי "שיקלולית" לצורך הפקת תלושי שכר
4. **מידע לעובדים** — גישה עצמית לנתוני השכר לעובדי הלקוחות
5. **תזמון ואוטומציה** — לוחות זמנים קבועים עם sequence פעולות לסגירת חודש שכר

### 1.2 קהל יעד

| תפקיד | תיאור | הרשאה |
|---|---|---|
| מנהל Nextage (Admin) | שולט בכל המערכת, מגדיר לקוחות, סוגר חודשים | System Admin |
| משתמש Nextage | מחשב/ת שכר — מנהל כרטיסי לקוחות ועובדים | Payroll Manager |
| מנהל משרד (לקוח) | מנהל משרד לקוח — מזין נתוני עובדים | Office Manager |
| מנכ"ל לקוח | צפייה בנתונים, אישורים | Executive Viewer |
| עובד לקוח | צפייה בנתוני השכר האישיים, מילוי טופס 101 | Employee Self-Service |

### 1.3 היקף המסמך

מסמך זה מגדיר:
- דרישות פונקציונליות ולא-פונקציונליות
- ארכיטקטורה טכנית לפריסה ב-Microsoft Azure
- מודל נתונים מלא
- עיצוב API (OpenAPI 3.x)
- מסכים וחוויית משתמש
- מודל אבטחה מבוסס Zero Trust
- תהליכי CI/CD ו-DevOps
- פערים ושאלות פתוחות

**מחוץ להיקף:** הפיתוח של "שיקלולית" עצמה, מערכת Priority, מערכת N-Files.

---

## 2. דרישות פונקציונליות

### 2.1 ניהול לקוחות

| ID | דרישה | פירוט |
|---|---|---|
| F-CLT-01 | ניהול כרטיס לקוח | כרטיס לכל לקוח Nextage עם: פרטים כלליים, יומן סגירות, הערות, מסמכים מצורפים, התכתבויות |
| F-CLT-02 | יומן פעילות | הגדרת לוח זמנים לסגירת חודש: תאריכי חגים, ימי חופשה, תאריך סגירת חודש שכר |
| F-CLT-03 | פתיחה/נעילת חודש | נעילת חודש על-ידי משתמש Nextage בלבד; פתיחה מחדש רק על-ידי מנהל Nextage |
| F-CLT-04 | ייבוא לקוחות מ-Priority | שאיבת נתוני לקוחות דרך Priority API בעת הוספת לקוח חדש |
| F-CLT-05 | מצב Active/Inactive | אפשרות להשבית/הפעיל מחדש לקוחות |
| F-CLT-06 | חיפוש לקוחות | חיפוש לפי: שם חברה (עברית/אנגלית), מספר חברה, עם auto-complete |

### 2.2 ניהול עובדים

| ID | דרישה | פירוט |
|---|---|---|
| F-EMP-01 | כרטיס עובד | פרטים אישיים (עברית + אנגלית), פרטי העסקה, נתוני שכר, מסמכים, תיצמת חוזה, הערות, יומן אישי |
| F-EMP-02 | ייבוא עובדים מ-Excel | ייבוא bulk מ-Excel עם validation ושגיאות inline |
| F-EMP-03 | הוספה ידנית | הוספת עובד חדש בטופס |
| F-EMP-04 | שדות עם היסטוריה | כל שינוי בשדה רגיש (שכר, מצב משפחתי, אחוז משרה) נשמר עם: ערך ישן, ערך חדש, תאריך, מי שינה |
| F-EMP-05 | מספר עובד | מספר עובד נלקח מתוכנת השכר (מספר נומרי) |
| F-EMP-06 | עובדים שעזבו | עובדים לא נמחקים — מועברים ל-status "עזב" עם תאריך עזיבה |
| F-EMP-07 | [GAP IDENTIFIED] — שדות עובד מלאים | המפרט המקורי מציין שדות חלקיים בלבד. יש לקבוע רשימה מלאה של שדות חובה ורשות לכרטיס העובד בהתאם לדרישות חוקיות ישראליות ולדרישות שיקלולית |

### 2.3 נתוני שכר חודשי

| ID | דרישה | פירוט |
|---|---|---|
| F-PAY-01 | תצוגה חודשית | טבלת עובדים עם נתוני שכר לחודש נבחר |
| F-PAY-02 | העתקת נתונים קבועים | בפתיחת חודש חדש — נתונים קבועים מועתקים אוטומטית. נתונים משתנים — ריקים |
| F-PAY-03 | נתונים מחוזה | שדות הנגזרים מתיצמת החוזה מתעדכנים אוטומטית ומסומנים בצבע; עדיין ניתן לשנות ידנית |
| F-PAY-04 | שמירה אוטומטית | שמירה ל-cache בזמן עריכה; שמירה סופית ל-DB על Submit |
| F-PAY-05 | Submit חודש | לחיצת Submit נועלת את הנתונים. שינויים נוספים דורשים פתיחה מחדש על-ידי Nextage |
| F-PAY-06 | ייצוא לשיקלולית | ייצוא CSV/TXT/Excel בפורמט תואם שיקלולית — קובץ נפרד לכל לקוח |
| F-PAY-07 | ייבוא מ-Excel | ייבוא נתוני שכר מ-Excel עם mapping ו-validation |
| F-PAY-08 | ייצוא PDF/Excel | ייצוא טבלת שכר ל-PDF ול-Excel |

### 2.4 טופס 101

| ID | דרישה | פירוט |
|---|---|---|
| F-101-01 | מילוי דיגיטלי | ממשק wizard למילוי טופס 101 — ניתן דרך browser או smartphone |
| F-101-02 | שמירה ישירה | נתוני הטופס הופכים ישירות לרשומות העובד במערכת |
| F-101-03 | notification לNextage | בסיום מילוי → notification (email + Teams) למשתמש Nextage הרלוונטי |
| F-101-04 | [CLARIFICATION NEEDED] — חוקיות | האם מילוי דיגיטלי של טופס 101 ללא חתימה ידנית מותר חוקית בישראל? יש לבדוק עם יועץ משפטי |

### 2.5 מסמכים ומצורפים

| ID | דרישה | פירוט |
|---|---|---|
| F-ATT-01 | העלאת קבצים | העלאת קבצים לכרטיס עובד או לקוח — כל סוג קובץ עד 50MB |
| F-ATT-02 | קטגוריזציה | קטגוריות: חוזה / שכר / אישי / טפסים / אחר |
| F-ATT-03 | שמירת אימייל מ-Outlook | Add-in ל-Outlook לשמירת אימייל ל-NPS עם שיוך לחברה + עובד |
| F-ATT-04 | רשימת קבצים | ניהול, הורדה, מחיקה (עם הרשאה), preview |

### 2.6 דוחות

| ID | דרישה | פירוט |
|---|---|---|
| F-RPT-01 | ריכוז תלושים | ריכוז תלושי שכר של כל העובדים (עבודת ניירות) |
| F-RPT-02 | טופס הסבת / העברה לבנק | ספוט ב"ס/טופס העברה לבנק |
| F-RPT-03 | דוח ביטוח לאומי + מס הכנסה (102) | דוח 102 |
| F-RPT-04 | דוח קופות | דוח קופות גמל / פנסיה |
| F-RPT-05 | דוח היעדרויות | דוח היעדרויות עובדים |
| F-RPT-06 | Report Generator | יצירת דוחות חדשים, שמירת דוחות אישיים, שיתוף דוחות (לפי הרשאה) |
| F-RPT-07 | פילטרים לפי הרשאה | כל דוח מסונן לפי מה שהמשתמש מורשה לראות |
| F-RPT-08 | [GAP IDENTIFIED] — מסכי דוחות | המפרט המקורי ציין שהמסכים עדיין לא הוכנו. יש להגדיר כל דוח מפורט לפני פיתוח |

### 2.7 התראות ותזמון

| ID | דרישה | פירוט |
|---|---|---|
| F-NOT-01 | התראה טרם סגירת חודש | Email + Teams notification למנהל המשרד X ימים לפני תאריך סגירת חודש (X מוגדר) |
| F-NOT-02 | התראה על אירועים | התראה על כל פעולה מוגדרת במערכת (Submit, שינוי נתונים רגישים, etc.) |
| F-NOT-03 | ניהול rules | ממשק ויזואלי לניהול כללי התראות (ערוץ, תזמון, נמענים) |
| F-NOT-04 | [CLARIFICATION NEEDED] — מי מקבל התראות? | יש להגדיר מדויקת לכל event מי הנמען: מנהל הלקוח? מחשב שכר Nextage? שניהם? |

### 2.8 Integrations

| ID | מערכת | סוג | פירוט |
|---|---|---|---|
| F-INT-01 | Priority ERP | API (outbound) | שאיבת נתוני לקוחות חדשים |
| F-INT-02 | N-Files | API | שאיבת נתונים (file storage?) |
| F-INT-03 | CIBUS | API | שאיבת נתוני ארוחות/קצובות לעובדים |
| F-INT-04 | BMP | API | [CLARIFICATION NEEDED] — מה זה BMP ומה טבע ה-integration? |
| F-INT-05 | שיקלולית | File Export | ייצוא CSV/TXT/Excel בפורמט מוסכם — ללא API |
| F-INT-06 | Microsoft Graph | API | שליחת Email + Teams notifications; Outlook Add-in |
| F-INT-07 | [CLARIFICATION NEEDED] — SuccessFactors (SF) | ? | המפרט שאל "האם לשאוב נתוני לקוחות מ-SF?" — לא הוחלט |

### 2.9 ניהול הרשאות

| ID | דרישה | פירוט |
|---|---|---|
| F-AUTH-01 | Roles מוגדרים | 5 roles: System Admin, Payroll Manager (Nextage), Office Manager, Executive Viewer, Employee |
| F-AUTH-02 | RBAC | כל feature + endpoint מסומן ב-permission level הנדרש |
| F-AUTH-03 | Multi-company | משתמש יכול להיות משויך ליותר מחברה אחת; בעת כניסה בוחר חברה (אם יותר מאחת) |
| F-AUTH-04 | הרשאות מותאמות | ניתן להגדיר הרשאה ספציפית לעובד מעבר ל-role הבסיסי |
| F-AUTH-05 | Hidden Companies | אפשרות להסתיר חברות ממשתמשים מסוימים |

### 2.10 Chatbot

| ID | דרישה | פירוט |
|---|---|---|
| F-BOT-01 | שיחה עם נציג וירטואלי | תמיכה בעברית ואנגלית, שיחות נשמרות |
| F-BOT-02 | Escalation | העברה לנציג אנושי עם context |
| F-BOT-03 | [CLARIFICATION NEEDED] — scope ה-chatbot | מה הנושאים שה-bot עונה עליהם? שאלות על שכר? תמיכה טכנית? כל התחומים? יש להגדיר intent list |

---

## 3. דרישות לא-פונקציונליות

### 3.1 ביצועים ו-SLA

| מדד | יעד |
|---|---|
| Response time — ממוצע | < 500ms לבקשות API |
| Response time — P95 | < 2,000ms |
| Response time — דף ראשוני (LCP) | < 2,500ms |
| זמינות (Availability) | 99.9% (≈ 8.7 שעות downtime/שנה) |
| זמינות — שעות peak | 99.95% |
| Throughput | 200 concurrent users ללא degradation |
| DB Query P95 | < 100ms |
| File Upload (50MB) | < 30 שניות |
| Recovery Time Objective (RTO) | < 4 שעות |
| Recovery Point Objective (RPO) | < 1 שעה |

### 3.2 אבטחה ותאימות

#### Zero Trust
- כל בקשה מאומתת ומורשית — גם בתוך הרשת הפנימית
- No implicit trust — token נדרש לכל API call
- Principle of Least Privilege — כל role מקבל הרשאות מינימליות

#### OWASP Top 10 Mitigation
| סיכון | מיטיגציה |
|---|---|
| Injection (SQL, XSS) | EF Core parameterized queries; Content Security Policy; Input validation |
| Broken Authentication | Entra ID + MFA; PKCE flow; token expiry |
| Sensitive Data Exposure | TLS 1.3; at-rest encryption; no PII in logs |
| Security Misconfiguration | IaC (Bicep) enforced configs; security scanning ב-CI/CD |
| IDOR | Resource-level authorization checks on every API endpoint |

#### תאימות
- **GDPR / חוק הגנת הפרטיות הישראלי:** נתוני עובדים הם PII. יש לתעד: מה נאסף, לכמה זמן, מי ניגש. Right to access + right to deletion.
- **Data Residency:** נתונים נשמרים ב-Azure region Israel Central (אם זמין) או West Europe
- **Audit Log:** כל פעולה רגישה נרשמת: מי עשה מה ומתי

### 3.3 סקיילביליטי

- **Horizontal Scaling:** Azure App Service Auto-scale (לפי CPU/Memory/Request queue)
- **DB Scaling:** Azure SQL Elastic Pool לגדילה עתידית
- **Multi-tenancy:** הארכיטקטורה מאפשרת הפרדה לוגית בין לקוחות ב-DB אחד (schema-based)
- **יעד 3 שנים:** תמיכה ב-500 לקוחות, 10,000 עובדים

### 3.4 Observability

| רכיב | כלי | מה נמדד |
|---|---|---|
| Structured Logging | Azure Application Insights (Serilog → AppInsights) | כל request, errors, warnings |
| Distributed Tracing | Application Insights Dependency Tracking | API calls, DB queries, external integrations |
| Metrics | Azure Monitor + Custom Metrics | Response times, error rates, active users |
| Alerting | Azure Monitor Alerts → Teams / Email | Error rate > 1%, Response time > 3s, DB CPU > 80% |
| Dashboard | Azure Monitor Workbooks | Real-time operational dashboard |
| Log retention | 90 יום (hot), 1 שנה (cold — Azure Storage) | |

---

## 4. ארכיטקטורה טכנית

### 4.1 תיאור תרשים

```
[Users: Browsers / Outlook Add-in]
       ↓ HTTPS + JWT (Entra ID)
[Azure Front Door — WAF + CDN + TLS termination]
       ↓
[Azure App Service — ASP.NET Core 8]
  ┌─────────────────────────────────────────┐
  │ API Layer (Controllers + OpenAPI 3.x)   │
  │ Auth Module | Payroll Module             │
  │ Employee Module | Client Module          │
  │ Reports Module | Files Module            │
  │ Notifications Module | Integration Module│
  └────────────┬────────────────────────────┘
               │
  ┌────────────┼────────────────────────────┐
  │            │                            │
  ▼            ▼                            ▼
Azure SQL   Azure Cache              Azure Blob Storage
Database    for Redis               (Documents + Exports)
               │
  ┌────────────▼────────────────────────────┐
  │     Azure Service Bus (Async Events)    │
  │  Notifications | Integrations | Exports │
  └─────────────────────────────────────────┘
               │
  ┌────────────▼─────────────────────────────────────────┐
  │ External Integrations                                 │
  │ Priority API | N-Files | CIBUS | BMP | Microsoft Graph│
  └───────────────────────────────────────────────────────┘

[Cross-cutting]
  Azure Key Vault — Secrets
  Microsoft Entra ID — Identity
  Application Insights — Observability
  Azure DevOps — CI/CD
```

### 4.2 Component Breakdown

| רכיב | טכנולוגיה | אחריות |
|---|---|---|
| Frontend SPA | React 18 + TypeScript + Fluent UI v9 + Vite | ממשק משתמש מלא |
| Backend API | ASP.NET Core 8 (Modular Monolith) | לוגיקה עסקית + API |
| Database | Azure SQL Database (General Purpose) | persistence |
| Cache | Azure Cache for Redis | Session, payroll draft data |
| File Storage | Azure Blob Storage | Attachments, exports |
| Identity | Microsoft Entra ID | Authentication + Authorization |
| Message Bus | Azure Service Bus | Async events (notifications, exports) |
| Notifications | Azure Functions (timer) + Microsoft Graph | Scheduled + event-driven notifications |
| Chatbot | Azure Bot Service + Azure OpenAI | Self-service support |
| Outlook Add-in | Office Add-ins (JavaScript API) | Save email to NPS |
| CDN + WAF | Azure Front Door | Security + performance |
| Secrets | Azure Key Vault | Connection strings, API keys |
| Observability | Application Insights + Azure Monitor | Logs, traces, metrics |
| CI/CD | Azure DevOps Pipelines | Build, test, deploy |
| IaC | Bicep | Infrastructure provisioning |

### 4.3 Data Flow — סגירת חודש שכר

```
1. מנהל משרד (לקוח) → מזין נתוני עובדים (POST /api/payroll/{month})
   → שמירה ב-Redis cache (draft)

2. מנהל משרד → Submit חודש (POST /api/payroll/{month}/submit)
   → נתונים נשמרים ב-Azure SQL
   → Service Bus Event: "PayrollSubmitted"
   → Azure Function: שולח notification למחשב שכר Nextage

3. מחשב שכר Nextage → בוחן נתונים → מייצא לשיקלולית
   (GET /api/payroll/{month}/export?clientId=X&format=csv)
   → קובץ נוצר ב-Azure Blob Storage
   → Signed URL מוחזר ל-client להורדה

4. מחשב שכר → נועל חודש (POST /api/payroll/{month}/lock)
   → סטטוס עודכן ב-DB
   → כל עריכות נוספות חסומות
```

---

## 5. מודל נתונים

### 5.1 Entities מרכזיות

```sql
-- naming: snake_case בDB, camelCase ב-API

-- לקוחות
clients (
  id                  UNIQUEIDENTIFIER PK,
  priority_client_id  VARCHAR(50),          -- מזהה ב-Priority
  name_he             NVARCHAR(200) NOT NULL,
  name_en             NVARCHAR(200),
  company_number      VARCHAR(20),
  status              VARCHAR(20) DEFAULT 'active', -- active/inactive
  created_at          DATETIME2 NOT NULL,
  created_by          UNIQUEIDENTIFIER FK → users(id),
  updated_at          DATETIME2,
  updated_by          UNIQUEIDENTIFIER FK → users(id)
)

-- עובדים
employees (
  id                  UNIQUEIDENTIFIER PK,
  client_id           UNIQUEIDENTIFIER FK → clients(id),
  payroll_number      INT NOT NULL,         -- מספר בתוכנת שכר
  first_name_he       NVARCHAR(100) NOT NULL,
  last_name_he        NVARCHAR(100) NOT NULL,
  first_name_en       NVARCHAR(100),
  last_name_en        NVARCHAR(100),
  email               VARCHAR(200),
  id_number           VARCHAR(20),          -- ת"ז (encrypted)
  start_date          DATE NOT NULL,
  end_date            DATE,                 -- תאריך עזיבה
  status              VARCHAR(20) DEFAULT 'active',
  base_salary         DECIMAL(12,2),
  salary_type         VARCHAR(20),          -- global/hourly
  position_percent    DECIMAL(5,2),         -- 0-100
  annual_leave_days   INT,
  section_14          BIT,
  shareholder_above_10 BIT,
  created_at          DATETIME2 NOT NULL,
  created_by          UNIQUEIDENTIFIER FK → users(id)
)

-- נתוני שכר חודשי
payroll_monthly (
  id                  UNIQUEIDENTIFIER PK,
  employee_id         UNIQUEIDENTIFIER FK → employees(id),
  client_id           UNIQUEIDENTIFIER FK → clients(id),
  payroll_month       DATE NOT NULL,        -- תמיד ה-1 לחודש
  status              VARCHAR(20) DEFAULT 'draft', -- draft/submitted/locked
  submitted_at        DATETIME2,
  submitted_by        UNIQUEIDENTIFIER FK → users(id),
  locked_at           DATETIME2,
  locked_by           UNIQUEIDENTIFIER FK → users(id)
)

-- רכיבי שכר (dynamic)
payroll_items (
  id                  UNIQUEIDENTIFIER PK,
  payroll_monthly_id  UNIQUEIDENTIFIER FK → payroll_monthly(id),
  item_code           VARCHAR(50) NOT NULL,
  item_name_he        NVARCHAR(200),
  value               DECIMAL(14,2),
  source              VARCHAR(20),          -- manual/contract/auto
  created_at          DATETIME2,
  updated_at          DATETIME2
)

-- היסטוריית שדות
field_history (
  id                  UNIQUEIDENTIFIER PK,
  entity_type         VARCHAR(50) NOT NULL, -- employee/client/contract
  entity_id           UNIQUEIDENTIFIER NOT NULL,
  field_name          VARCHAR(100) NOT NULL,
  old_value           NVARCHAR(MAX),
  new_value           NVARCHAR(MAX),
  changed_at          DATETIME2 NOT NULL,
  changed_by          UNIQUEIDENTIFIER FK → users(id),
  change_reason       NVARCHAR(500)
)

-- משתמשים
users (
  id                  UNIQUEIDENTIFIER PK,
  entra_id            VARCHAR(200) UNIQUE NOT NULL, -- Azure AD Object ID
  email               VARCHAR(200) NOT NULL,
  display_name        NVARCHAR(200),
  role                VARCHAR(50) NOT NULL,  -- system_admin/payroll_manager/office_manager/executive_viewer/employee
  is_active           BIT DEFAULT 1,
  last_login          DATETIME2,
  created_at          DATETIME2 NOT NULL
)

-- שיוך משתמש לחברות
user_clients (
  user_id             UNIQUEIDENTIFIER FK → users(id),
  client_id           UNIQUEIDENTIFIER FK → clients(id),
  role_override       VARCHAR(50),           -- override role ספציפי לחברה זו
  PRIMARY KEY (user_id, client_id)
)

-- מסמכים מצורפים
attachments (
  id                  UNIQUEIDENTIFIER PK,
  entity_type         VARCHAR(50) NOT NULL, -- employee/client
  entity_id           UNIQUEIDENTIFIER NOT NULL,
  file_name           NVARCHAR(500) NOT NULL,
  blob_path           VARCHAR(1000) NOT NULL,
  category            VARCHAR(50),
  file_size_bytes     BIGINT,
  content_type        VARCHAR(200),
  uploaded_at         DATETIME2 NOT NULL,
  uploaded_by         UNIQUEIDENTIFIER FK → users(id)
)

-- יומן סגירות
payroll_calendar (
  id                  UNIQUEIDENTIFIER PK,
  client_id           UNIQUEIDENTIFIER FK → clients(id),
  payroll_month       DATE NOT NULL,
  close_date          DATE NOT NULL,
  notes               NVARCHAR(MAX),
  created_by          UNIQUEIDENTIFIER FK → users(id),
  created_at          DATETIME2 NOT NULL
)

-- הגדרות התראות
notification_rules (
  id                  UNIQUEIDENTIFIER PK,
  client_id           UNIQUEIDENTIFIER,     -- NULL = כל הלקוחות
  event_type          VARCHAR(100) NOT NULL,
  days_before         INT,
  channels            VARCHAR(200),         -- email,teams,inapp
  recipient_roles     VARCHAR(200),         -- office_manager,payroll_manager
  is_active           BIT DEFAULT 1
)

-- Audit Log
audit_log (
  id                  UNIQUEIDENTIFIER PK,
  user_id             UNIQUEIDENTIFIER FK → users(id),
  action              VARCHAR(100) NOT NULL,
  entity_type         VARCHAR(50),
  entity_id           UNIQUEIDENTIFIER,
  details             NVARCHAR(MAX),        -- JSON
  ip_address          VARCHAR(50),
  timestamp           DATETIME2 NOT NULL
)
```

### 5.2 Naming Conventions

| שכבה | Convention | דוגמה |
|---|---|---|
| Database Tables | snake_case | `payroll_monthly` |
| DB Columns | snake_case | `client_id`, `created_at` |
| API Response (JSON) | camelCase | `clientId`, `createdAt` |
| API Routes | kebab-case | `/api/payroll-monthly/{id}` |
| C# Classes | PascalCase | `PayrollMonthlyService` |
| C# Properties | PascalCase | `ClientId`, `CreatedAt` |

---

## 6. API Design

### 6.1 OpenAPI 3.x — מבנה כללי

```yaml
openapi: 3.1.0
info:
  title: NPS — Nextage Payroll System API
  version: 2.0.0
  description: API לניהול נתוני שכר ועובדים
servers:
  - url: https://api.nps.nextage.co.il/v2
    description: Production
  - url: https://api-staging.nps.nextage.co.il/v2
    description: Staging

security:
  - BearerAuth: []

components:
  securitySchemes:
    BearerAuth:
      type: http
      scheme: bearer
      bearerFormat: JWT
      description: "Azure Entra ID JWT Token. Scope: api://nps/access_as_user"
```

### 6.2 Endpoints מרכזיים

#### Authentication
```
POST   /auth/token          # Exchange Entra ID code → internal session
DELETE /auth/token          # Logout
GET    /auth/me             # Current user info + permissions
```

#### Clients
```
GET    /clients                    # רשימת לקוחות (paginated, filtered)
POST   /clients                    # הוספת לקוח חדש
GET    /clients/{clientId}         # כרטיס לקוח
PATCH  /clients/{clientId}         # עדכון פרטי לקוח
DELETE /clients/{clientId}         # deactivate (לא מחיקה)
GET    /clients/{clientId}/calendar # יומן סגירות
PUT    /clients/{clientId}/calendar/{month} # עדכון יומן חודש
```

#### Employees
```
GET    /clients/{clientId}/employees                    # רשימת עובדים
POST   /clients/{clientId}/employees                    # הוספת עובד
GET    /clients/{clientId}/employees/{employeeId}       # כרטיס עובד
PATCH  /clients/{clientId}/employees/{employeeId}       # עדכון עובד
GET    /clients/{clientId}/employees/{employeeId}/history # היסטוריית שדות
POST   /clients/{clientId}/employees/import             # ייבוא מ-Excel (multipart/form-data)
```

#### Payroll
```
GET    /clients/{clientId}/payroll/{month}              # נתוני שכר חודשי
PUT    /clients/{clientId}/payroll/{month}              # שמירת draft
POST   /clients/{clientId}/payroll/{month}/submit       # Submit חודש
POST   /clients/{clientId}/payroll/{month}/lock         # נעילת חודש (Nextage admin)
POST   /clients/{clientId}/payroll/{month}/unlock       # פתיחת חודש (Nextage admin)
GET    /clients/{clientId}/payroll/{month}/export       # ייצוא לשיקלולית (?format=csv|xlsx|txt)
```

#### Reports
```
GET    /reports                    # רשימת דוחות זמינים
POST   /reports/run                # הרצת דוח (async → job ID)
GET    /reports/jobs/{jobId}       # סטטוס דוח (pending/running/completed)
GET    /reports/jobs/{jobId}/download # הורדת תוצאה
POST   /reports/saved              # שמירת דוח אישי
GET    /reports/saved              # דוחות שמורים שלי
```

#### Attachments
```
GET    /{entityType}/{entityId}/attachments           # רשימת קבצים
POST   /{entityType}/{entityId}/attachments           # העלאת קובץ (multipart)
GET    /attachments/{attachmentId}/download           # הורדה (Signed URL)
DELETE /attachments/{attachmentId}                    # מחיקה
```

#### Notifications
```
GET    /notifications                   # התראות שלי (unread first)
PATCH  /notifications/{id}/read         # סימון כנקרא
GET    /notification-rules              # כללי התראות
POST   /notification-rules              # הוספת כלל
PUT    /notification-rules/{id}         # עדכון כלל
```

### 6.3 Request/Response דוגמה

**GET /clients/{clientId}/payroll/2025-03 — Response:**
```json
{
  "month": "2025-03",
  "clientId": "3fa85f64-...",
  "status": "draft",
  "employees": [
    {
      "employeeId": "abc12345-...",
      "payrollNumber": 1001,
      "name": "ישראל ישראלי",
      "items": [
        {
          "itemCode": "BASE_SALARY",
          "itemNameHe": "שכר בסיס",
          "value": 12000.00,
          "source": "contract"
        },
        {
          "itemCode": "OVERTIME",
          "itemNameHe": "שעות נוספות",
          "value": 0,
          "source": "manual"
        }
      ]
    }
  ],
  "totalCount": 47,
  "lastUpdatedAt": "2025-03-15T10:30:00Z",
  "lastUpdatedBy": "mor.mordechay@nextage.co.il"
}
```

**Error Response (standard):**
```json
{
  "error": {
    "code": "PAYROLL_ALREADY_LOCKED",
    "message": "לא ניתן לערוך — חודש מרץ 2025 נעול",
    "details": {
      "lockedAt": "2025-03-20T14:00:00Z",
      "lockedBy": "admin@nextage.co.il"
    },
    "traceId": "00-abc123-def456-00"
  }
}
```

---

## 7. מסכים ו-UX

### סיכום מסכים

| # | שם המסך | תפקיד | מורכבות |
|---|---|---|---|
| 1 | Login | כולם | נמוכה |
| 2 | Dashboard | Nextage Users | גבוהה |
| 3 | Payroll Screen | Office Manager + Nextage | גבוהה מאוד |
| 4 | Company Settings | Office Manager + Admin | בינונית |
| 5 | Employee — Monthly View | Office Manager + Nextage | גבוהה |
| 6 | Employee — Attachments | Office Manager + Nextage | בינונית |
| 7 | Employee — Contract Summary | Nextage | בינונית |
| 8 | Employee — Form 101 | Employee | גבוהה |
| 9 | Notification Center | כולם | בינונית |
| 10 | Chatbot | כולם | גבוהה (AI) |
| 11 | Permissions | Admin | בינונית |
| 12 | Shiklulit Export | Nextage | בינונית |
| 13 | Nextage Admin Homepage | Nextage | בינונית |
| 14 | Save Email (Outlook Add-in) | Nextage | בינונית |

> פירוט מלא של כל מסך — ראה שלב 4 לעיל.

**ספריית UI מומלצת:** [Fluent UI React v9](https://react.fluentui.dev/) — design system רשמי של Microsoft, RTL מובנה, accessibility, dark mode, מתאים לארגון Microsoft 365.

---

## 8. אבטחה

### 8.1 Authentication & Authorization

**Authentication:**
- **Microsoft Entra ID (Azure AD)** כ-Identity Provider יחיד
- **PKCE Authorization Code Flow** לאפליקציית ה-SPA (MSAL.js v3)
- **JWT Bearer Tokens** ל-API (Backend validates via JWKS endpoint)
- **MFA חובה** דרך Entra ID Conditional Access Policy לכל roles מלבד Employee
- **Token expiry:** Access Token — 1 שעה; Refresh Token — 24 שעות

**Authorization:**
- **RBAC בשכבת API** — כל Controller מסומן ב-`[Authorize(Roles="...")]`
- **Resource-level checks** — כל endpoint בודק ש-clientId בbody תואם לlקוח שהמשתמש מורשה לגשת
- **Permission table בDB** — לcustomizations מעבר ל-role

```
Role Hierarchy:
  system_admin → payroll_manager → office_manager → executive_viewer → employee
```

### 8.2 הצפנת נתונים

| שכבה | שיטה |
|---|---|
| In-Transit | TLS 1.3 בלבד (Azure Front Door + App Service) |
| At-Rest (DB) | Azure SQL Transparent Data Encryption (TDE) — AES-256 |
| At-Rest (Blob) | Azure Blob Storage Server-Side Encryption — AES-256 |
| שדות רגישים (ת"ז) | Column-level encryption ב-DB (Always Encrypted) |
| Client-side | HTTPS Strict; Content Security Policy; no sensitive data in localStorage |

### 8.3 Secrets Management

- **Azure Key Vault** — כל connection strings, API keys, certificates
- **App Service Managed Identity** — App Service ניגש ל-Key Vault ללא credentials
- **אין credentials ב-code** — CI/CD pipeline מטעין secrets מ-Key Vault
- **Key rotation** — 90 יום לAPI keys, 365 יום לcertificates

### 8.4 Audit Logging

כל הפעולות הבאות נרשמות ב-`audit_log`:

| פעולה | פרטים נרשמים |
|---|---|
| Login / Logout | user, IP, timestamp, success/failure |
| שינוי נתוני עובד | user, field, old value, new value, timestamp |
| Submit / Lock / Unlock חודש | user, client, month, timestamp |
| ייצוא נתונים | user, client, month, format, timestamp |
| שינוי הרשאות | admin user, target user, change, timestamp |
| מחיקת קובץ | user, file name, entity, timestamp |

- Audit logs **אינם ניתנים למחיקה** (append-only)
- שמירה: 3 שנים
- גישה: System Admin בלבד

---

## 9. פריסה ו-DevOps

### 9.1 CI/CD Pipeline — Azure DevOps

```yaml
# azure-pipelines.yml (תיאור)
stages:
  - stage: Build
    jobs:
      - job: Build_Backend
        steps:
          - dotnet restore
          - dotnet build (Release)
          - dotnet test (unit + integration tests)
          - dotnet publish
      - job: Build_Frontend
        steps:
          - npm ci
          - npm run type-check
          - npm run lint
          - npm run build

  - stage: SecurityScan
    jobs:
      - OWASP Dependency Check
      - Trivy container scan
      - SonarCloud code analysis

  - stage: Deploy_Staging
    condition: branch == 'main'
    jobs:
      - Azure App Service Deploy (staging slot)
      - Run smoke tests against staging
      - Run E2E tests (Playwright)

  - stage: Deploy_Production
    condition: manual approval
    jobs:
      - Swap staging slot → production
      - Run production health checks
      - Notify team via Teams
```

### 9.2 Environment Strategy

| סביבה | URL | מטרה | Azure Resources |
|---|---|---|---|
| Development (local) | localhost | פיתוח | Docker Compose (SQL + Redis local) |
| Dev Cloud | dev.nps.nextage.co.il | CI tests | App Service (Free/B1) + Azure SQL (Basic) |
| Staging | staging.nps.nextage.co.il | QA + UAT | App Service (S2) + Azure SQL (Standard) |
| Production | nps.nextage.co.il | פרודקשן | App Service (P2v3) + Azure SQL (General Purpose) |

### 9.3 Infrastructure as Code — Bicep

```bicep
// תיאור מבנה Bicep (לא קוד מלא)
modules:
  - app-service.bicep       // App Service Plan + App
  - sql-database.bicep      // Azure SQL Server + DB
  - redis-cache.bicep       // Azure Cache for Redis
  - storage.bicep           // Blob Storage + containers
  - key-vault.bicep         // Key Vault + access policies
  - front-door.bicep        // Azure Front Door + WAF policy
  - monitoring.bicep        // Application Insights + Log Analytics
  - service-bus.bicep       // Service Bus namespace + queues/topics
```

**Git Repository Structure:**
```
/
├── src/
│   ├── NPS.Api/            # ASP.NET Core 8 API
│   ├── NPS.Core/           # Domain entities + interfaces
│   ├── NPS.Infrastructure/ # EF Core, repositories, integrations
│   └── NPS.Functions/      # Azure Functions (notifications)
├── frontend/               # React 18 + TypeScript
├── infra/                  # Bicep templates
├── tests/
│   ├── unit/
│   ├── integration/
│   └── e2e/                # Playwright
└── .azuredevops/
    └── azure-pipelines.yml
```

### 9.4 Monitoring & Alerting

| Alert | סף | ערוץ |
|---|---|---|
| Error rate > 1% (5 min) | 1% | Teams + Email |
| Response time P95 > 3s | 3,000ms | Teams |
| DB CPU > 80% (10 min) | 80% | Email |
| Failed logins > 20/min | 20 | Teams (Security) |
| Disk/Blob anomaly | pattern | Email |
| Deployment failure | any | Teams |

---

## 10. פערים ושאלות פתוחות

### [CLARIFICATION NEEDED] — שאלות לבהרה לפני פיתוח

| # | שאלה | קריטיות | מי צריך לענות |
|---|---|---|---|
| C-01 | **טופס 101 דיגיטלי** — האם מילוי ושליחה של טופס 101 ללא הדפסה וחתימה ידנית מותר חוקית בישראל? | גבוהה | יועץ משפטי |
| C-02 | **SuccessFactors (SF)** — האם מחליטים לשלב? אם כן, מה מגיע מSF — נתוני עובדים? | גבוהה | Nextage Product |
| C-03 | **BMP Integration** — מה זה BMP? מה מגיע ממנו? האם יש API? | גבוהה | Nextage Tech |
| C-04 | **Chatbot Scope** — מה perimeters השאלות שה-chatbot עונה? מה ה-fallback לנציג? | בינונית | Nextage Product |
| C-05 | **Notifications — נמענים** — לכל event, מי בדיוק מקבל notification? (מחשב שכר Nextage? מנהל משרד? שניהם?) | בינונית | Nextage Ops |
| C-06 | **Teams integration** — האם כל משתמשי Nextage ב-Microsoft Teams? האם ניתן לשלוח Teams messages? | בינונית | IT |
| C-07 | **Multi-language reports** — האם דוחות צריכים להיות בעברית בלבד או גם באנגלית? | נמוכה | Nextage Product |
| C-08 | **CIBUS** — מה מגיע מ-CIBUS? האם יש API רשמי או scraping? | בינונית | Nextage Tech |
| C-09 | **N-Files** — מה מגיע מ-N-Files? מה הפורמט? יש API? | בינונית | Nextage Tech |
| C-10 | **Data retention** — כמה זמן שומרים נתוני שכר? (חוק מחייב 7 שנות ארכיון בישראל) | גבוהה | יועץ משפטי + Nextage |

### [GAP IDENTIFIED] — פערים שזוהו במפרט המקורי

| # | פער | השפעה | המלצה |
|---|---|---|---|
| G-01 | **שדות עובד מלאים** — המפרט מציין שדות חלקיים בלבד. אין מיפוי מלא לשדות שיקלולית | גבוהה | לקבל מ-Nextage מפרט מלא של שדות שיקלולית |
| G-02 | **מסכי דוחות** — המפרט המקורי ציין מפורשות שמסכי הדוחות לא הוכנו | גבוהה | לבנות spec מפורט לכל דוח |
| G-03 | **פורמט ייצוא שיקלולית** — לא מוגדר בדיוק הפורמט, עמודות, encoding של קבצי הייצוא | גבוהה | לקבל spec format מ-שיקלולית |
| G-04 | **Employee Self-Service** — לא ברור מה העובד רואה בחשבון שלו (תלושים? כל השכר? רק טופס 101?) | בינונית | להגדיר scope מלא של employee portal |
| G-05 | **Chatbot ספק** — המפרט ציין "חברת Webtech" ללא פירוט. ב-2025 מומלץ Azure Bot Service + OpenAI | בינונית | לסגור החלטה לפני פיתוח |
| G-06 | **DB Schema חסר** — 7 טבלאות בלבד, ללא foreign keys, ללא indexes, ללא constraints | גבוהה | מוגדר בשלב 5 של מסמך זה — לאשר |
| G-07 | **SLA לא מוגדר** — לא הוגדרו דרישות ביצועים כלל | גבוהה | מוגדר בסעיף 3.1 — לאשר |
| G-08 | **API לPriority** — לא מוגדר איזה endpoints, authentication, version | בינונית | לקבל API docs מPriority |
| G-09 | **גיבוי ו-DR** — לא מוגדרת כל אסטרטגיית גיבוי | גבוהה | מוגדר ב-Azure SQL + section 3.1 — לאשר |
| G-10 | **רב-שוניות UI** — מוזכרת תמיכה בעברית/אנגלית אך אין הגדרה של i18n strategy | נמוכה | להגדיר כיוון (i18next? resource files?) |

### החלטות מומלצות לפני תחילת פיתוח

**Priority גבוהה (חסמים):**
1. ✅ אשר שדות עובד מלאים (G-01)
2. ✅ קבל פורמט ייצוא שיקלולית מדויק (G-03)
3. ✅ הבהר BMP + N-Files + SF (C-02, C-03)
4. ✅ בדוק חוקיות טופס 101 דיגיטלי (C-01)
5. ✅ הגדר scope Employee Self-Service (G-04)

**Priority בינונית:**
6. ✅ הגדר chatbot scope (C-04, G-05)
7. ✅ הגדר notifications matrix — event → recipients (C-05)
8. ✅ הגדר spec מסכי דוחות (G-02)

---

*מסמך זה הוכן כעדכון מלא למפרט NPS המקורי מ-2017. כל הלוגיקה העסקית נשמרה — רק היישום הטכנולוגי עודכן לסטנדרטים של 2025 בהתאם לסביבת Microsoft Azure + Microsoft 365 של Nextage.*

*© Nextage בע"מ | גרסה 2.0 | ינואר 2025*
