import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { AuthProvider, useAuth } from "@/lib/auth";
import { Loader2 } from "lucide-react";
import NotFound from "@/pages/not-found";
import LoginPage from "@/pages/login";
import RegisterPage from "@/pages/register";
import AdminDashboard from "@/pages/admin-dashboard";
import UserDashboard, { SitesTab, ProxyTab } from "@/pages/user-dashboard";
import AgentDashboard from "@/pages/agent-dashboard";

function SitesPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Sites & Forms</h1>
        <p className="text-muted-foreground text-sm mt-1">Scrape and manage the forms your agents will fill</p>
      </div>
      <SitesTab />
    </div>
  );
}

function ProxyPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Proxy Settings</h1>
        <p className="text-muted-foreground text-sm mt-1">Configure geo-targeted proxy routing for form submissions</p>
      </div>
      <ProxyTab />
    </div>
  );
}

function DashboardRouter() {
  const { user } = useAuth();
  if (!user) return null;

  if (user.role === "admin") return <AdminDashboard />;
  if (user.role === "agent") return <AgentDashboard />;
  return <UserDashboard />;
}

function AuthenticatedLayout() {
  const { user, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">Loading...</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <Switch>
        <Route path="/register" component={RegisterPage} />
        <Route path="/login" component={LoginPage} />
        <Route><LoginPage /></Route>
      </Switch>
    );
  }

  const sidebarStyle = {
    "--sidebar-width": "16rem",
    "--sidebar-width-icon": "3rem",
  };

  return (
    <SidebarProvider style={sidebarStyle as React.CSSProperties}>
      <div className="flex h-screen w-full">
        <AppSidebar />
        <div className="flex flex-col flex-1 min-w-0">
          <header className="flex items-center gap-2 p-3 border-b shrink-0">
            <SidebarTrigger data-testid="button-sidebar-toggle" />
          </header>
          <main className="flex-1 overflow-auto p-6">
            <div className="max-w-6xl mx-auto">
              <Switch>
                <Route path="/" component={DashboardRouter} />
                <Route path="/sites" component={SitesPage} />
                <Route path="/proxy" component={ProxyPage} />
                <Route component={NotFound} />
              </Switch>
            </div>
          </main>
        </div>
      </div>
    </SidebarProvider>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <AuthProvider>
          <AuthenticatedLayout />
          <Toaster />
        </AuthProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
