import { AppLayout } from "@/components/app-layout";
import { useAppController } from "@/hooks/use-app-controller";

export default function App() {
  const controller = useAppController();
  return <AppLayout controller={controller} />;
}
