import { useAuth } from "@/lib/auth";
import { useLocation, Link } from "wouter";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarFooter,
  SidebarHeader,
  useSidebar,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Shield, LayoutDashboard, LogOut, PanelLeftClose, PanelLeft } from "lucide-react";
import { Users } from "lucide-react";
import { Globe } from "lucide-react";
import { Network } from "lucide-react";
import { FileText } from "lucide-react";
import { useEffect } from "react";

export function AppSidebar() {
  const { user, logout } = useAuth();
  const [location] = useLocation();
  const { state, setOpen, open } = useSidebar();

  useEffect(() => {
    setOpen(false);
  }, []);

  if (!user) return null;

  const adminItems = [
    { title: "Dashboard", url: "/", icon: LayoutDashboard },
    { title: "Users", url: "/admin/users", icon: Users },
  ];

  const userItems = [
    { title: "Dashboard", url: "/", icon: LayoutDashboard },
    { title: "Sites", url: "/sites", icon: Globe },
    { title: "Proxy", url: "/proxy", icon: Network },
  ];

  const agentItems = [
    { title: "Dashboard", url: "/", icon: LayoutDashboard },
    { title: "Submissions", url: "/submissions", icon: FileText },
  ];

  const items = user.role === "admin" ? adminItems : user.role === "agent" ? agentItems : userItems;

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="p-4 flex flex-row items-center justify-between">
        <div className="flex items-center gap-3 overflow-hidden">
          <div className="w-9 h-9 rounded-md bg-primary flex items-center justify-center shrink-0">
            <Shield className="w-5 h-5 text-primary-foreground" />
          </div>
          {state === "expanded" && (
            <div className="animate-in fade-in duration-300">
              <h2 className="font-bold font-mono text-sm tracking-tight">ProxyForm</h2>
              <p className="text-xs text-muted-foreground">v1.0</p>
            </div>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 ml-auto"
          onClick={() => setOpen(!open)}
        >
          {state === "expanded" ? <PanelLeftClose className="h-4 w-4" /> : <PanelLeft className="h-4 w-4" />}
        </Button>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Navigation</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {items.map((item) => (
                <SidebarMenuItem key={item.title}>
                  <SidebarMenuButton asChild data-active={location === item.url}>
                    <Link href={item.url}>
                      <item.icon className="w-4 h-4" />
                      <span>{item.title}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="p-4 space-y-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
            <span className="text-sm font-semibold text-primary">
              {user.name?.charAt(0).toUpperCase()}
            </span>
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium truncate">{user.name}</p>
            <div className="flex items-center gap-2">
              <Badge variant="secondary" className="text-xs">
                {user.role}
              </Badge>
            </div>
          </div>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start"
          onClick={logout}
          data-testid="button-logout"
        >
          <LogOut className="w-4 h-4 mr-2" />
          Sign Out
        </Button>
      </SidebarFooter>
    </Sidebar>
  );
}
