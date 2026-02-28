# ProxyForm

Full-stack SaaS application for automated proxy-based form filling.

## Tech Stack
- **Frontend**: React + TypeScript + Tailwind CSS + Shadcn UI
- **Backend**: Node.js + Express.js
- **Database**: PostgreSQL with Drizzle ORM
- **Auth**: JWT tokens stored in localStorage (supports Bearer header + query param for SSE)
- **Form Scraping**: Cheerio + Axios
- **Browser Automation**: Puppeteer + puppeteer-extra + stealth plugin

## Architecture

### Database Models
- **users**: name, email, password(hashed), role(admin/user/agent), isActive, parentUserId, proxy config fields, lastActive
- **sites**: ownerId, name, url, formSelector, submitSelector, fields(JSONB), isActive, scrapedAt
- **agent_sites**: junction table for agent-site assignments
- **submissions**: agentId, siteId, formData, proxy info, status, screenshot, duration

### User Roles
- **admin**: Sees all users, stats, can enable/disable/delete users, create users manually
- **user**: Adds target websites, scrapes forms, configures proxy, creates agent accounts
- **agent**: Fills forms for assigned sites, views submission history

### Key Files
- `shared/schema.ts` - All database schemas and Zod validation
- `server/routes.ts` - All API endpoints (includes SSE for auto-fill progress)
- `server/storage.ts` - Database CRUD operations
- `server/auth.ts` - JWT middleware (Bearer header + query param)
- `server/scraper.ts` - Cheerio form scraper
- `server/browser.ts` - Puppeteer auto-fill engine with stealth plugin
- `client/src/lib/auth.tsx` - Auth context provider
- `client/src/pages/admin-dashboard.tsx` - Admin panel
- `client/src/pages/user-dashboard.tsx` - User dashboard with 3 tabs
- `client/src/pages/agent-dashboard.tsx` - Agent form filling + live progress UI
- `client/src/components/app-sidebar.tsx` - Navigation sidebar

### API Routes
- `POST /api/auth/login` - Login
- `POST /api/auth/register` - Register
- `GET /api/auth/me` - Current user
- `GET /api/admin/users` - All users (admin)
- `GET /api/admin/stats` - Dashboard stats (admin)
- `PATCH /api/admin/users/:id/toggle` - Toggle user active (admin)
- `DELETE /api/admin/users/:id` - Delete user (admin)
- `POST /api/admin/users` - Create user (admin)
- `POST /api/sites/scrape` - Scrape URL for form fields
- `POST /api/sites` - Save site
- `GET /api/sites` - Get user's sites
- `DELETE /api/sites/:id` - Delete site
- `POST /api/agents` - Create agent
- `GET /api/agents` - Get user's agents
- `DELETE /api/agents/:id` - Delete agent
- `PUT /api/proxy` - Save proxy config
- `GET /api/proxy` - Get proxy config
- `POST /api/proxy/test` - Test proxy connection
- `GET /api/agent/sites` - Agent's assigned sites
- `GET /api/agent/submissions` - Agent's submissions
- `GET /api/agent/submissions/:id/progress` - SSE stream for auto-fill progress
- `POST /api/agent/submissions` - Submit form & trigger Puppeteer auto-fill

### Design
- Dark theme (forced via HTML class="dark")
- Fonts: DM Sans (body), Space Mono (code/mono)
- Primary color: Blue (#3b82f6 range)

### Geo-Targeting Logic
- Zip field names (priority 1): zip, zipcode, zip_code, postal, postalcode, postal_code
- State field names (priority 2): state, state_name
- Proxy username format: `{baseUsername}-zip-{value}` or `{baseUsername}-state-{value}`
- Geo data extracted from agent form submissions and stored in submissions table (proxyHost, proxyPort, proxyLocation)
- Helper functions: extractGeoTarget(), buildGeoProxyUsername() in server/routes.ts

### Phases
- Phase 1: Auto Form Scraper (COMPLETE)
- Phase 2: Decodo Proxy Configuration (COMPLETE - polished UI with status badge, test results, geo preview)
- Phase 3: Smart Proxy Geo-Targeting (COMPLETE - backend extraction, agent UI preview, submission tracking)
- Phase 4: Headless Browser Auto-Fill (COMPLETE - Puppeteer + stealth, human-like typing 40-120ms, SSE progress, screenshot capture)

### Auto-Fill Engine (server/browser.ts)
- Uses puppeteer-extra with stealth plugin to avoid bot detection
- Geo-targeted proxy passed as --proxy-server launch arg + page.authenticate()
- Fields filled in ascending order by field.order
- Human-like typing: random 40-120ms delay per character
- Random inter-field delays calibrated so total fill time is ~30-40 seconds
- Takes screenshot after submission
- Sends real-time progress via SSE (text/event-stream)
- Results stored in PostgreSQL submissions table (status, screenshot as base64, duration, errorMessage)

### Environment Variables
- DATABASE_URL - PostgreSQL connection
- JWT_SECRET - JWT signing secret
- ADMIN_EMAIL - Auto-created admin email
- ADMIN_PASSWORD - Auto-created admin password
