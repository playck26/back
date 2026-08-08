-- CreateTable
CREATE TABLE "config_pagamento_empresa" (
    "id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "link_pagamento_url" TEXT,
    "whatsapp_numero" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "config_pagamento_empresa_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "config_pagamento_empresa_company_id_key" ON "config_pagamento_empresa"("company_id");

-- AddForeignKey
ALTER TABLE "config_pagamento_empresa" ADD CONSTRAINT "config_pagamento_empresa_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "empresas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
