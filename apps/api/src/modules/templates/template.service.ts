import { prisma } from "../../config/prisma";

class TemplateService {
  async list() {
    return prisma.messageTemplate.findMany({
      orderBy: { createdAt: "desc" }
    });
  }

  async create(data: {
    name: string;
    text: string;
    mediaUrl?: string;
    spinEnabled?: boolean;
    isActive?: boolean;
  }) {
    return prisma.messageTemplate.create({
      data: {
        name: data.name,
        text: data.text,
        mediaUrl: data.mediaUrl,
        spinEnabled: data.spinEnabled ?? false,
        isActive: data.isActive ?? true
      }
    });
  }

  async update(id: string, data: Partial<{ name: string; text: string; mediaUrl: string | null; spinEnabled: boolean; isActive: boolean }>) {
    return prisma.messageTemplate.update({
      where: { id },
      data
    });
  }

  async remove(id: string) {
    await prisma.messageTemplate.delete({ where: { id } });
  }
}

export const templateService = new TemplateService();
